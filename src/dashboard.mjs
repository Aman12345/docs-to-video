// A small web page for the demo: pick a storyboard, click "Make video", watch the job,
// play and approve the result. Protected with a password when DEMO_PASSWORD is set.
import { authorModel, repairModel, reviewModel, chat, parseJson, newUsage } from './ai.mjs';
import { SETTINGS, setting, saveSettings, poolForNewJob, guidelines, addGuideline, removeGuideline } from './settings.mjs';
import { RUNNERS, kickRunners, githubReady } from './runners.mjs';
import crypto from 'node:crypto';
import { VOICES, defaultVoice, isVoice, perVideo } from './voices.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { bucket, approveVideo, streamFile } from './store.mjs';
import { REVIEW_CODES, reviseStoryboard } from './review.mjs';
import { SCRIPT_RULES } from './author.mjs';
import { narrationOn } from './compose.mjs';
import { listLogins, startLive, getLive, liveAction, liveShot, saveLive, closeLive, deleteLogin, cleanName, VIEWPORT } from './logins.mjs';

const SB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'storyboards');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (d) => { if (!d) return ''; const s = Math.round((Date.now() - new Date(d)) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

async function storyboards() {
  const files = (await fs.readdir(SB_DIR)).filter((f) => f.endsWith('.json'));
  return Promise.all(files.map(async (f) => ({ file: f, ...JSON.parse(await fs.readFile(path.join(SB_DIR, f), 'utf8')) })));
}

function readForm(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 2e5) req.destroy(); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(d))));
  });
}

// Basic auth: DEMO_PASSWORD, plus DEMO_USER as the username when it is set.
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export function basicAuthOk(header = '') {
  if (!header.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  const userOk = process.env.DEMO_USER ? same(user, process.env.DEMO_USER) : true;
  return same(rest.join(':'), process.env.DEMO_PASSWORD || '') && userOk;
}
function allowed(req, res) {
  if (!process.env.DEMO_PASSWORD) return true;
  if (basicAuthOk(req.headers.authorization)) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="docs-to-video demo"' }).end('Password required');
  return false;
}

// Re-record videos from their saved steps (no Claude planning, so under a cent each). Used after an
// app release: from the dashboard, or by POST /videos/rerecord from a deploy hook or schedule.
export async function queueRerecords(db, filter = {}, source = 'rerecord', voice) {
  const vids = await db.collection('videos').find(filter, { projection: { slug: 1, storyboard: 1 } }).toArray();
  // Videos made before steps were stored on the video itself: use the latest version's saved steps.
  for (const v of vids.filter((x) => !x.storyboard)) {
    v.storyboard = (await db.collection('video_versions').findOne({ slug: v.slug }, { sort: { version: -1 }, projection: { storyboard: 1 } }))?.storyboard;
  }
  for (let i = vids.length - 1; i >= 0; i--) if (!vids[i].storyboard) vids.splice(i, 1);
  const busy = new Set((await db.collection('jobs').find({ status: { $in: ['queued', 'running'] }, rerecordOf: { $exists: true } }, { projection: { rerecordOf: 1 } }).toArray()).map((j) => j.rerecordOf));
  const todo = vids.filter((v) => !busy.has(v.slug));
  if (todo.length) {
    await db.collection('jobs').insertMany(todo.map((v, i) => ({
      status: 'queued', storyboard: v.storyboard, rerecordOf: v.slug, attempts: 0, createdAt: new Date(Date.now() + i), source, ...(voice ? { voice } : {}), ...poolForNewJob(),
    })));
  }
  await kickRunners(db).catch(() => {});
  return todo.length;
}

const redirect = (res, to = '/') => res.writeHead(303, { Location: to }).end();

// ---- Review: AI review results, approval and the review page ----
const userOf = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':')[0] || 'someone' : 'someone'; };
const needsReview = (v) => v.status === 'draft' && (!v.live || v.live.version < v.version);
function reviewSummary(v) {
  const r = v.review;
  if (!r || r.state === 'skipped') return 'The AI editor didn\'t review this one; please watch it.';
  if (r.state === 'question') return `The AI editor asks: ${r.question}`;
  if (r.state === 'failed' || r.state === 'passed' && r.findings?.length) return `The AI editor couldn't fix ${r.findings.length} problem${r.findings.length > 1 ? 's' : ''} in 2 rounds.`;
  return `The AI editor approved it${r.changed ? `, but ${r.changed}` : ''}; it's waiting for a person.`;
}
function reviewPills(v) {
  const pill = (t, c) => `<span class="pill" style="background:${c[0]};color:${c[1]}">${t}</span>`;
  const out = [];
  if (v.live) out.push(pill(`Live v${v.live.version}`, ['#ecfdf3', '#067647']));
  if (needsReview(v)) out.push(pill(`v${v.version} needs review`, ['#fffaeb', '#b54708']));
  else if (v.status === 'rejected') out.push(pill(`v${v.version} rejected`, ['#fef3f2', '#b42318']));
  else if (v.status === 'changes-requested') out.push(pill(`v${v.version}: changes requested`, ['#f4f3ff', '#5925dc']));
  else if (!v.live) out.push(pill(`v${v.version} ${esc(v.status)}`, ['#f2f4f7', '#344054']));
  return out.join(' ');
}
function reviewLine(v) {
  if (['auto', 'ai'].includes(v.live?.approvedBy) && v.live.version === v.version) return `<div class="meta" style="margin-top:6px;color:#067647">✓ ${v.live.approvedBy === 'ai' ? 'Approved by the AI editor' : 'Approved automatically'}: ${esc(v.live.reason?.replace(/^Approved by the AI editor \([^)]*\): /, '') || 'nothing changed')}</div>`;
  if (!v.review || !needsReview(v)) return '';
  const r = v.review;
  return `<div class="meta" style="margin-top:6px;color:${r.state === 'question' ? '#5925dc' : r.state === 'failed' ? '#b42318' : '#344054'}">${r.state === 'question' ? '?' : r.state === 'failed' ? '⚠' : '•'} ${esc(reviewSummary(v))}</div>`;
}
function reviewPage(v, { msg } = {}) {
  const r = v.review || { state: 'skipped', findings: [], fixes: [] };
  const scenes = v.storyboard?.scenes || [];
  const liveScenes = v.live?.storyboard?.scenes || [];
  const step = (s, i) => {
    const f = (r.findings || []).filter((x) => x.step === i + 1);
    return `<section class="step${f.length ? ' flagged' : ''}"><div class="txt"><h3>${s.check ? '✓ ' : `${i + 1}. `}${esc(s.chapter)}</h3><p>"${esc(s.narration || '')}"</p>
      ${liveScenes[i] && liveScenes[i].narration !== s.narration ? `<p class="meta">Live version said: "${esc(liveScenes[i].narration || '')}"</p>` : ''}
      ${f.map((x) => `<p class="finding">⚠ <strong>${esc(REVIEW_CODES[x.code] || x.code)}</strong>: ${esc(x.note)}</p>`).join('')}</div>
      <div class="shots"><figure><img loading="lazy" src="/ui/review/${esc(v.slug)}/steps/${i + 1}?v=${v.version}" alt=""><figcaption>New (v${v.version})</figcaption></figure>
      ${v.live?.files?.steps?.[i] ? `<figure><img loading="lazy" src="/videos/${esc(v.slug)}/steps/${i + 1}?v=${v.live.version}" alt=""><figcaption>Live (v${v.live.version})</figcaption></figure>` : ''}</div></section>`;
  };
  const verdict = r.state === 'question' ? ['#f4f3ff', '#5925dc', '? The AI editor has a question for you']
    : r.state === 'failed' || (r.state === 'passed' && r.findings?.length) ? ['#fef3f2', '#b42318', `⚠ The AI editor couldn't fix ${r.findings.length} problem${r.findings.length > 1 ? 's' : ''} in 2 rounds`]
      : ['approved', 'passed'].includes(r.state) ? ['#ecfdf3', '#067647', `✓ The AI editor approved it${r.changed ? `, but ${r.changed}` : ''}`]
        : ['#f2f4f7', '#344054', 'The AI editor didn\'t review this version'];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review: ${esc(v.title)}</title>
<style>*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f7f8fa;color:#1d2433}main{max-width:1100px;margin:0 auto;padding:24px 16px 60px}h1{font-size:22px;margin:4px 0}
.card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:16px 18px;margin-bottom:16px}.meta{color:#667085;font-size:13px}a{color:#3b5bdb}
.vids{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}video{width:100%;border-radius:10px;background:#111827}
.verdict{padding:10px 14px;border-radius:10px;font-weight:600;margin-bottom:10px}.step{display:grid;grid-template-columns:1fr 1.6fr;gap:16px;background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:14px;margin-bottom:12px}
.step.flagged{border-color:#fda29b}.step h3{margin:0 0 6px;font-size:16px}.step p{margin:0 0 6px}.finding{color:#b42318}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
figure{margin:0}figure img{width:100%;border-radius:8px;border:1px solid #e4e7ec}figcaption{font-size:12px;color:#667085}
.actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}textarea{width:100%;min-height:80px;font:inherit;padding:8px 10px;border:1px solid #d0d5dd;border-radius:8px}
button{font:inherit;font-weight:600;border-radius:8px;padding:9px 16px;cursor:pointer;border:1px solid #d0d5dd;background:#fff}.approve{background:#067647;color:#fff;border-color:#067647}.use{font-size:12px;padding:3px 9px;margin-left:4px}.changes{background:#680BBD;color:#fff;border-color:#680BBD}.reject{color:#b42318}
.ok{background:#ecfdf3;border:1px solid #abefc6;color:#067647;padding:10px 14px;border-radius:8px;margin-bottom:14px}@media (max-width:720px){.step{grid-template-columns:1fr}}</style></head><body><main>
<p class="meta"><a href="/">← Dashboard</a></p><h1>${esc(v.title)}</h1>
<div class="meta">Draft v${v.version}${v.live ? ` · live is v${v.live.version} (approved ${v.live.approvedBy === 'auto' ? 'automatically' : `by ${esc(v.live.approvedBy || 'someone')}`})` : ' · new video, nothing live yet'}</div>
${msg ? `<div class="ok" style="margin-top:12px">${esc(msg)}</div>` : ''}
<section class="card" style="margin-top:14px"><div class="verdict" style="background:${verdict[0]};color:${verdict[1]}">${verdict[2]}</div>
${r.question ? `<p style="font-size:16px;margin:4px 0 10px"><strong>${esc(r.question)}</strong></p><p class="meta">Answer it under "Request changes" below (or approve as it is).</p>` : ''}
${r.summary ? `<p class="meta">Editor's summary${r.model ? ` (${esc(r.model)})` : ''}: ${esc(r.summary)}</p>` : ''}
${r.fixes?.length ? `<p class="meta">Fixed automatically before you saw it: ${esc(r.fixes.join(' '))}</p>` : ''}
${(r.findings || []).length ? `<ul>${r.findings.map((x) => `<li>Step ${x.step}: <strong>${esc(REVIEW_CODES[x.code] || x.code)}</strong>: ${esc(x.note)}${(x.request || x.suggestion) ? `<br><span class="meta">Suggested change: "${esc(x.request || x.suggestion)}"</span> <button type="button" class="use" data-s="${esc(x.request || x.suggestion)}">Use this</button>` : ''}</li>`).join('')}</ul>` : ''}
${v.reviewNote ? `<p class="meta">Last change request: "${esc(v.reviewNote.note)}" → ${esc(v.reviewNote.summary || '')}</p>` : ''}</section>
<section class="card"><div class="vids"><div><strong>New (v${v.version})</strong><video controls preload="metadata" src="/ui/review/${esc(v.slug)}/video?v=${v.version}"></video></div>
${v.live ? `<div><strong>Live now (v${v.live.version})</strong><video controls preload="metadata" src="/videos/${esc(v.slug)}/video?v=${v.live.version}"></video></div>` : ''}</div></section>
<h2 style="font-size:17px">Step by step</h2>${scenes.map(step).join('')}
<section class="card"><h2 style="font-size:17px;margin-top:0">Your decision</h2><div class="actions">
<form method="post" action="/ui/review/${esc(v.slug)}/approve"><p>Make v${v.version} the live version: share links and the support agent use it from now on.</p><button class="approve">Approve v${v.version}</button></form>
<form id="changes" method="post" action="/ui/review/${esc(v.slug)}/changes"><p>Describe what to change. Wording and example values are edited directly; if it needs different or extra steps (e.g. "show the other approver options"), the AI plans the video again with your feedback. Either way it comes back here.</p><textarea id="note" name="note" required placeholder="e.g. Show the approver options and briefly say when to use each, then pick Direct manager"></textarea>
<label class="meta" style="display:flex;gap:6px;align-items:center;margin:6px 0"><input type="checkbox" name="remember" value="1"> Also remember this for future videos (adds a team guideline)</label><button class="changes">Request changes</button></form>
<form method="post" action="/ui/review/${esc(v.slug)}/reject"><p>Don't use v${v.version}.${v.live ? ` v${v.live.version} stays live.` : ''}</p><button class="reject">Reject v${v.version}</button></form>
</div></section></main>
<script>for (const b of document.querySelectorAll('.use')) b.onclick = () => { const t = document.getElementById('note'); t.value = b.dataset.s; t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.focus(); };</script></body></html>`;
}

// ---- Job activity: what a job did, step by step ----
// Turns log lines into plain words for the jobs table and the activity page.
const targetName = (j) => { try { const t = JSON.parse(j); return t.name || t.label || t.placeholder || t.text || t.testId || j; } catch { return j; } };
const shorten = (v) => (v.length > 80 ? `${v.slice(0, 77)}…` : v);
function friendly(msg = '') {
  return String(msg)
    .replace(/^( {2}|AI takeover: )?(click|fill|select|press|hover|expect) (\{.*?\})(?: value="(.*?)")?(?= \(|$)/, (m, pre = '', d, t, v) => {
      const n = targetName(t);
      const say = d === 'click' ? `Select "${n}"` : d === 'fill' ? `Type "${shorten(v || '')}" into "${n}"` : d === 'select' ? `Choose "${v}" in "${n}"`
        : d === 'press' ? `Press ${n}` : d === 'hover' ? `Point to "${n}"` : `Check "${n}" is on screen`;
      return `${pre === 'AI takeover: ' ? 'The AI did: ' : pre}${say}`;
    })
    .replace(/^( {2})?wait until "(.*?)" \((\d+)s max\)/, '$1Wait for "$2" (up to $3s)')
    .replace(/ \((instead|first)\) - /, (m, u) => (u === 'instead' ? ' instead. Why: ' : ' first. Why: '))
    .replace(/^( {2})?press (\S+)$/, '$1Press $2')
    .replace(/^step (\d+) of/, 'Step $1 of')
    .replace(/^plan: done after (\d+) actions/, 'The AI finished planning ($1 actions)')
    .replace(/^plan: failed /, 'The AI tried: ').replace(/^plan: preparing test data off-camera first: /, 'Test data is missing, so the AI prepares it off-camera first: ').replace(/^plan: /, 'The AI planned: ')
    .replace(/^setup: failed /, 'Preparing test data, tried: ').replace(/^setup: /, 'Preparing test data (off-camera): ')
    .replace(/^cleanup: failed /, 'Cleaning up, tried: ').replace(/^cleanup: /, 'Cleaning up test records (off-camera): ')
    .replace(/^voiceover \((.*?)\): .*/, 'Voice made with $1')
    .replace(/^started \(attempt (\d+)\): (.*)/, 'Started (attempt $1)')
    .replace(/^ {2}/, '');
}
const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
function jobPage(j) {
  const ev = j.events || [];
  const t0 = ev[0] ? new Date(ev[0].at) : null;
  const live = j.status === 'running' || j.status === 'queued';
  const kind = (m) => (/AI takeover|AI \(|AI fixed|the AI .*taking over/i.test(m) ? 'ai'
    : /failed|didn't work|not working|could not|warning/i.test(m) ? 'bad'
    : /^started|^stored|^done|^composed|^recorded/.test(m) ? 'key' : /^step \d+ of/.test(m) ? 'step' : '');
  const rows = ev.map((e) => `<tr class="${kind(e.msg)}"><td class="t">${t0 ? clock(new Date(e.at) - t0) : ''}</td><td>${esc(friendly(e.msg))}</td></tr>`).join('');
  const c = j.cost;
  const done = j.status === 'done' && j.result?.slug;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Job activity</title>${live ? '<meta http-equiv="refresh" content="4">' : ''}
<style>:root{--line:#e4e7ec;--muted:#667085}*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f7f8fa;color:#1d2433}main{max-width:900px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:21px;margin:4px 0}.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:16px}.meta{color:var(--muted);font-size:13px}a{color:#3b5bdb}
.pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600;background:#f2f4f7}.pill.running{background:#fffaeb;color:#b54708}.pill.done{background:#ecfdf3;color:#067647}.pill.failed{background:#fef3f2;color:#b42318}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:5px 8px;border-top:1px solid #f2f4f7;vertical-align:top}td.t{color:var(--muted);width:56px;font-variant-numeric:tabular-nums}
tr.step td{font-weight:600;padding-top:12px}tr.ai td:last-child{color:#5925dc}tr.ai td:last-child::before{content:"✦ "}tr.bad td:last-child{color:#b42318}tr.key td:last-child{color:#067647}
img{max-width:100%;border:1px solid var(--line);border-radius:8px;margin-top:10px}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:10px 0 0;font-size:14px}dt{color:var(--muted)}dd{margin:0}</style></head><body><main>
<p class="meta"><a href="/">← Dashboard</a></p>
<h1>${esc(j.storyboard?.title || j.prompt)}</h1>
<div class="meta"><span class="pill ${esc(j.status)}">${esc(j.status)}</span> &nbsp;queued ${ago(j.createdAt)} · attempt ${j.attempts || 0}${live ? ' · this page updates itself' : ''}</div>
<section class="card"><dl>
${j.prompt ? `<dt>Request</dt><dd>${esc(j.prompt)}</dd>` : ''}${j.login || j.storyboard?.login ? `<dt>Signed in as</dt><dd>${esc(j.login || j.storyboard.login)}</dd>` : ''}
${j.voice ? `<dt>Voice</dt><dd>${esc(j.voice)}</dd>` : ''}${j.rerecordOf ? `<dt>Re-record of</dt><dd><a href="/v/${esc(j.rerecordOf)}">${esc(j.rerecordOf)}</a></dd>` : ''}
${c ? `<dt>Cost</dt><dd>$${c.total.toFixed(3)} (AI $${c.planning.toFixed(3)} · voice $${c.voice.toFixed(3)} · server $${c.server.toFixed(3)} for ${c.serverSec}s)</dd>` : ''}
${done ? `<dt>Video</dt><dd><a href="/v/${esc(j.result.slug)}">Watch v${j.result.version}</a></dd>` : ''}
${j.status === 'failed' ? `<dt>Error</dt><dd style="color:#b42318">${esc((j.error || '').split('\n')[0])}</dd>` : ''}
</dl>${j.failShot && j.status !== 'done' ? `<img src="/ui/jobs/${j._id}/fail.jpg" alt="The screen when it stopped">` : ''}</section>
<section class="card"><h2 style="font-size:16px;margin:0 0 6px">Activity</h2>
${rows ? `<table>${rows}</table>` : '<p class="meta">Nothing yet. Activity shows here once the job starts (jobs made before this feature have none).</p>'}
<p class="meta" style="margin-top:10px">✦ purple lines are the AI stepping in. Times are from the first line.</p></section>
</main></body></html>`;
}

// ---- Settings page: AI models and defaults, saved in MongoDB ----
// OpenRouter's public model list (no key needed), cached for an hour, for the model pickers.
let modelCache = { at: 0, list: [] };
async function openRouterModels() {
  if (Date.now() - modelCache.at < 3600_000 && modelCache.list.length) return modelCache.list;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models');
    const data = (await r.json()).data || [];
    modelCache = { at: Date.now(), list: data.filter((m) => !m.id.includes(':')).map((m) => ({
      id: m.id, name: m.name,
      inM: Number(m.pricing?.prompt || 0) * 1e6, outM: Number(m.pricing?.completion || 0) * 1e6,
      images: (m.architecture?.input_modalities || []).includes('image'),
      text: (m.architecture?.output_modalities || ['text']).includes('text'),
    })).filter((m) => m.text) };
  } catch { /* keep the old list */ }
  return modelCache.list;
}
const price = (m) => (m ? `$${+m.inM.toFixed(2)} in / $${+m.outM.toFixed(2)} out per million tokens${m.images ? ' · reads screenshots' : ' · text only'}` : 'not in OpenRouter\'s list');
const FROM = { settings: 'set here', render: 'from Render', default: 'built-in default' };

function settingsPage(models, { msg, err } = {}) {
  const byId = new Map(models.map((m) => [m.id, m]));
  const cur = Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, setting(k)]));
  const val = (k) => (cur[k].from === 'settings' ? cur[k].value : '');
  const note = (k, shown = cur[k].value) => `<span class="meta">In use: <strong>${esc(shown || '—')}</strong> (${FROM[cur[k].from]})</span>`;
  const plan = cur.authorModel.value, take = cur.repairModel.value || plan;
  const sel = (name, opts, value) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Settings</title>
<style>:root{--line:#e4e7ec;--muted:#667085;--brand:#3b5bdb}*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f7f8fa;color:#1d2433}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0 0 12px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}.meta{color:var(--muted);font-size:13px}
label{display:block;font-weight:600;margin:14px 0 4px}label:first-of-type{margin-top:0}input,select{width:100%;font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:#fff}
.price{display:block;color:var(--muted);font-size:13px;margin-top:4px}button{font:inherit;font-weight:600;background:var(--brand);color:#fff;border:0;border-radius:8px;padding:10px 18px;cursor:pointer}
.ok{background:#ecfdf3;border:1px solid #abefc6;color:#067647;padding:10px 14px;border-radius:8px;margin-bottom:14px}.err{background:#fef3f2;border:1px solid #fecdca;color:#b42318;padding:10px 14px;border-radius:8px;margin-bottom:14px}
.row{display:flex;gap:12px;flex-wrap:wrap}.row>div{flex:1;min-width:200px}a{color:var(--brand)}</style></head><body><main>
<p class="meta"><a href="/">← Dashboard</a></p><h1>Settings</h1>
<p class="meta">Changes apply from the next video; no redeploy needed. Leave a box empty to use the Render setting or the built-in default.</p>
${msg ? `<div class="ok">${esc(msg)}</div>` : ''}${err ? `<div class="err">${esc(err)}</div>` : ''}
<form method="post" action="/ui/settings">
<section class="card"><h2>AI models (through OpenRouter)</h2>
<label for="authorModel">Planning model</label>
<input id="authorModel" name="authorModel" list="models" value="${esc(val('authorModel'))}" placeholder="${esc(cur.authorModel.from === 'settings' ? '' : plan)}" autocomplete="off" spellcheck="false">
<span class="price">Plans each new video from your description. ${note('authorModel')} · ${esc(price(byId.get(plan)))}</span>
<label for="repairModel">Takeover model</label>
<input id="repairModel" name="repairModel" list="models" value="${esc(val('repairModel'))}" placeholder="same as planning (${esc(plan)})" autocomplete="off" spellcheck="false">
<span class="price">Fixes a step that stopped working while recording; it looks at screenshots. ${note('repairModel', take)} · ${esc(price(byId.get(take)))}</span>
<label for="reviewModel">AI editor (reviews every finished video)</label>
<input id="reviewModel" name="reviewModel" list="models" value="${esc(val('reviewModel'))}" placeholder="${esc(cur.reviewModel.value)}" autocomplete="off" spellcheck="false">
<span class="price">Decides whether each video is ready, fixes what it can and only asks you when it's genuinely unsure. A frontier model works best here; it must read screenshots. ${note('reviewModel')} · ${esc(price(byId.get(cur.reviewModel.value)))}</span>
<datalist id="models">${models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} · ${esc(price(m))}</option>`).join('')}</datalist>
<p class="meta" style="margin:12px 0 0">Type to search ${models.length || 'OpenRouter\'s'} models, e.g. <code>gpt-6.1-terra</code> or <code>claude</code>. <a href="/ui/ai-check" target="_blank">Test the models in use</a> (asks each one a small question).</p>
</section>
<section class="card"><h2>AI takeover</h2>
<div class="row"><div><label>When a step stops working</label>${sel('repair', [['', `Render / default (${cur.repair.from === 'settings' ? 'on' : cur.repair.value})`], ['on', 'Let the AI fix it'], ['off', 'Stop and report the error']], val('repair'))}
<span class="price">${note('repair')}</span></div>
<div><label>Tries per broken step</label><input name="repairMaxTurns" type="number" min="1" max="8" value="${esc(val('repairMaxTurns'))}" placeholder="${esc(cur.repairMaxTurns.value)}"><span class="price">${note('repairMaxTurns')}</span></div></div>
<label>AI review of every finished video</label>${sel('aiReview', [['', `Render / default (${cur.aiReview.from === 'settings' ? 'on' : cur.aiReview.value})`], ['on', 'On: check each video and fix what it can (up to 2 rounds)'], ['off', 'Off']], val('aiReview'))}
<span class="price">Looks at one screenshot per step against the narration: wrong screen, loading screens, visible personal data, an ending that doesn't show the result. About 6–7¢ per video with Opus as the editor. ${note('aiReview')}</span>
<label>Who approves videos</label>${sel('approvalMode', [['', `Render / default (${cur.approvalMode.from === 'settings' ? 'AI editor' : cur.approvalMode.value === 'person' ? 'a person' : 'AI editor'})`], ['ai', 'The AI editor, when it\'s confident; you only get its questions'], ['person', 'A person approves every new video']], val('approvalMode'))}
<span class="price">Visible personal data and anything the editor can't resolve in 2 rounds always come to you. ${note('approvalMode')}</span>
<label>Approve unchanged re-records automatically (when a person approves)</label>${sel('autoApprove', [['', `Render / default (${cur.autoApprove.from === 'settings' ? 'on' : cur.autoApprove.value})`], ['on', 'On: if the AI review passes and every step looks the same as the live version'], ['off', 'Off: a person approves every new version']], val('autoApprove'))}
<span class="price">New videos and changed screens always wait for a person on the review page. ${note('autoApprove')}</span>
<label>"Check your work" ending</label>${sel('checkStep', [['', `Render / default (${cur.checkStep.from === 'settings' ? 'on' : cur.checkStep.value})`], ['on', 'End each video by showing the result'], ['off', 'No ending step']], val('checkStep'))}
<span class="price">The AI picks the finished result, clears anything covering it, highlights it and writes one line about it. Added once per video, then saved with its steps. ${note('checkStep')}</span>
<label>Thinking effort (OpenAI GPT models only)</label>${sel('reasoningEffort', [['', `Render / default (${cur.reasoningEffort.from === 'settings' ? 'low' : cur.reasoningEffort.value})`], ['low', 'Low — fastest and cheapest'], ['medium', 'Medium'], ['high', 'High — slowest, for tricky screens']], val('reasoningEffort'))}
<span class="price">${note('reasoningEffort')}</span>
</section>
<section class="card"><h2>Where videos record</h2>
<label>New videos and re-records run on</label>${sel('recordOn', [['', `Render / default (${RUNNERS[cur.recordOn.value]?.short || cur.recordOn.value})`], ...Object.entries(RUNNERS).map(([k, r]) => [k, r.label])], val('recordOn'))}
<span class="price">${note('recordOn')}. <strong>GitHub Actions</strong>: each video gets its own 4-CPU machine, about 20 at once, free for this public repo. ${githubReady() ? 'The dashboard can start GitHub machines.' : '<span style="color:#b54708">Needs one-time setup: repo secrets on GitHub and GITHUB_DISPATCH_TOKEN on Render (see "Record on GitHub Actions" in the README).</span>'}
<strong>Google Cloud Run</strong>: set up once in Cloud Shell (cloudrun/README.md), then start batches with <code>bash cloudrun/run.sh</code>. Jobs already queued stay where they are.</span>
</section>
<section class="card"><h2>Voice</h2>
<label>Default voice for new videos</label>${sel('voice', [['', 'Render setting (TTS_MODEL / TTS_VOICE)'], ...VOICES.map((o) => [o.id, `${o.label} · ${perVideo(o)}`])], val('voice'))}
<span class="price">Preselected in the request forms; you can still pick another voice per video. In use: <strong>${esc(defaultVoice().label)}</strong>. <a href="/ui/voices">Listen to the voices</a></span>
</section>
<button type="submit">Save settings</button>
</form>
<section class="card" style="margin-top:16px"><h2>Team guidelines</h2>
<p class="meta" style="margin-top:0">Rules every new video follows, and the AI review checks. They come from reviewers' feedback ("Also remember this for future videos" on the review page), or add your own.</p>
${guidelines().length ? `<ol style="padding-left:20px">${guidelines().map((g, i) => `<li style="margin-bottom:6px">${esc(g.text)} <span class="meta">(${esc(g.by || '')})</span> <form method="post" action="/ui/guidelines/remove/${i}" style="display:inline"><button style="font-size:12px;padding:2px 8px;background:#fff;color:#b42318;border:1px solid #fecdca">Remove</button></form></li>`).join('')}</ol>` : '<p class="meta">None yet.</p>'}
<form method="post" action="/ui/guidelines/add"><label for="g">Add a guideline</label><input id="g" name="text" placeholder="e.g. When a setting has several options, show them and briefly say what each is for." maxlength="300"><button type="submit" style="margin-top:8px">Add</button></form></section>
</main></body></html>`;
}

// Voice dropdown for the request forms; the service default is preselected.
const pickVoice = (form) => (isVoice(form.voice) ? { voice: form.voice } : {});
function voiceSelect(id) {
  const def = defaultVoice().id;
  return `<div style="flex:0;min-width:230px"><label for="${id}"><strong>Voice</strong> <a class="meta" href="/ui/voices">listen</a></label><select id="${id}" name="voice">${VOICES.map((o) =>
    `<option value="${o.id}"${o.id === def ? ' selected' : ''}>${esc(o.label)} · ${esc(perVideo(o))}</option>`).join('')}</select></div>`;
}

function page({ sbs, jobs, videos, busy, error, msg, logins = [] }) {
  const statusPill = (s) => `<span class="pill ${s}">${esc(s)}</span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Docs to Video demo</title>${busy ? '<meta http-equiv="refresh" content="4">' : ''}
<style>
:root{--ink:#1d2433;--muted:#667085;--line:#e4e7ec;--brand:#3b5bdb;--bg:#f7f8fa}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
main{max-width:1040px;margin:0 auto;padding:28px 16px 60px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 12px}
.sub{color:var(--muted);margin:0 0 20px}.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px}
select,textarea,input[type=text]{font:inherit;width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:#fff}
textarea{font-family:ui-monospace,monospace;font-size:13px;min-height:110px}textarea.plain{font-family:inherit;font-size:15px;min-height:72px}
label{display:block;margin-bottom:6px}label.inline{display:flex;gap:6px;align-items:center;margin:0}.pill.planned{background:#f4f3ff;color:#5925dc}
.row{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.row>div{flex:1;min-width:240px}
button{font:inherit;padding:9px 18px;border-radius:8px;border:1px solid var(--brand);background:var(--brand);color:#fff;font-weight:600;cursor:pointer}
button.ghost{background:#fff;color:var(--brand)}details{margin-top:14px}summary{cursor:pointer;color:var(--muted)}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:middle}th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;background:#fafbfc}
.pill{font-size:12px;padding:2px 9px;border-radius:99px;background:#f2f4f7}.pill.queued{background:#eef2ff;color:#3538cd}.pill.running{background:#fffaeb;color:#b54708}
.pill.done,.pill.approved{background:#ecfdf3;color:#067647}.pill.failed{background:#fef3f2;color:#b42318}.pill.draft{background:#f2f4f7;color:#344054}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}.vid img{width:100%;border-radius:8px;border:1px solid var(--line);display:block}
.vid h3{font-size:16px;margin:10px 0 4px}.meta{color:var(--muted);font-size:13px}.actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.rerec{display:flex;gap:4px;align-items:center}.rerec select{width:auto;max-width:150px;font-size:12px;padding:5px 6px;margin:0}
a.btn{display:inline-block;padding:7px 14px;border-radius:8px;border:1px solid var(--line);color:var(--ink);text-decoration:none;background:#fff}
.err{background:#fef3f2;border:1px solid #fecdca;color:#b42318;padding:10px 14px;border-radius:8px;margin-bottom:14px}
.empty{color:var(--muted)}
</style></head><body><main>
<h1>Docs to Video</h1><p class="sub">Describe a how-to video, or pick a ready-made storyboard. An AI (through OpenRouter) plans the steps, Playwright records them in headless Chrome on Render, and videos are stored in MongoDB. <a href="/ui/voices">Compare voices</a> · <a href="/ui/settings">Settings</a></p>
${error ? `<div class="err">${esc(error)}</div>` : ''}${msg ? `<div style="background:#ecfdf3;border:1px solid #abefc6;color:#067647;padding:10px 14px;border-radius:8px;margin-bottom:14px">${esc(msg)}</div>` : ''}
${videos.some(needsReview) ? `<div class="card" style="margin-bottom:16px;border-color:#d6bbfb;background:#faf5ff"><h2 style="margin:0 0 8px;font-size:17px">Needs review (${videos.filter(needsReview).length})</h2>
${videos.filter(needsReview).map((v) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0;border-top:1px solid #e9d7fe;flex-wrap:wrap"><div><strong>${esc(v.title)}</strong> <span class="meta">v${v.version}${v.live ? ` · live is v${v.live.version}` : ' · new video'}</span><br><span class="meta">${esc(reviewSummary(v))}</span></div><a class="btn" style="background:#680BBD;color:#fff;border-color:#680BBD" href="/ui/review/${esc(v.slug)}">Review</a></div>`).join('')}</div>` : ''}
<div class="card" style="margin-bottom:16px"><form method="post" action="/ui/prompt">
<label for="prompt"><strong>Describe the video</strong></label>
<textarea id="prompt" name="prompt" class="plain" required placeholder="e.g. Search Wikipedia for Ada Lovelace and open her article"></textarea>
<div class="row" style="margin-top:12px"><div><label for="start"><strong>Start at</strong> <span class="meta">website address; leave empty to use the sample billing app</span></label>
<input id="start" name="startUrl" type="text" inputmode="url" autocomplete="off" placeholder="en.wikipedia.org"></div>
${logins.length ? `<div style="flex:0;min-width:200px"><label for="login"><strong>Signed in as</strong></label><select id="login" name="login"><option value="">Not signed in</option>${logins.map((l) => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join('')}</select></div>` : ''}
${voiceSelect('voice-p')}
<div style="flex:0;white-space:nowrap;padding-bottom:9px"><label class="inline meta"><input type="checkbox" name="planOnly" value="1"> Plan only</label></div>
<div style="flex:0"><button type="submit">Plan and record</button></div></div>
<p class="meta">The AI works out the clicks on the real site, then the video is recorded. Takes about 2–4 minutes. Sites that show a robot check won't work, and it never types passwords or completes purchases. For apps that need a login (like Miter staging), add a saved login below and pick it under "Signed in as"; leave "Start at" empty to start where you logged in.</p>
</form></div>
<div class="card"><form method="post" action="/ui/make"><div class="row"><div>
<label for="sb"><strong>Or pick a ready-made storyboard</strong></label>
<select id="sb" name="file">${sbs.map((s) => `<option value="${esc(s.file)}">${esc(s.title)} (${s.scenes.length} steps)</option>`).join('')}</select></div>
${voiceSelect('voice-s')}
<div style="flex:0"><button type="submit">Make video</button></div></div>
<details><summary>Or paste your own storyboard (JSON)</summary><textarea name="custom" placeholder='{"id":"my-video","title":"...","startUrl":"/#/dashboard","scenes":[...]}'></textarea>
<p class="meta">Steps can click, fill, select, pause or expect, targeting elements by role and name, label, test id or text. It runs against APP_URL, or the bundled sample app.</p></details>
</form></div>

<h2>Saved logins</h2>
<div class="card">${logins.length ? `<table style="margin-bottom:14px"><thead><tr><th>Name</th><th>Site</th><th>Saved</th><th></th></tr></thead><tbody>${logins.map((l) => `<tr><td><strong>${esc(l.name)}</strong></td><td class="meta">${esc(l.origin)}</td><td class="meta">${ago(l.savedAt)}</td><td><form method="post" action="/ui/logins/${esc(l.name)}/delete" style="display:inline"><button class="ghost" style="padding:3px 10px">Remove</button></form></td></tr>`).join('')}</tbody></table>` : ''}
<form method="post" action="/ui/logins/start"><div class="row">
<div style="flex:0;min-width:180px"><label for="lname"><strong>Name</strong></label><input id="lname" name="name" type="text" required placeholder="miter-staging"></div>
<div><label for="lurl"><strong>Sign-in page</strong></label><input id="lurl" name="url" type="text" required inputmode="url" autocomplete="off" placeholder="staging.example.com/login"></div>
<div style="flex:0"><button type="submit">Open login window</button></div></div>
<p class="meta">Opens the cloud browser here so you can sign in yourself. Only the signed-in session is saved, encrypted; your password is never stored. Use a test account with demo data, because videos show whatever is on screen.</p></form></div>

<h2>Jobs</h2>
${jobs.length ? `<table><thead><tr><th>Video</th><th>Status</th><th>Queued</th><th>Result</th></tr></thead><tbody>
${jobs.map((j) => {
  const c = j.cost;
  const cost = c ? ` &middot; <span title="AI planning and fixes $${c.planning.toFixed(4)} · voice $${c.voice.toFixed(4)} (${c.voiceChars} characters) · server $${c.server.toFixed(4)} (${c.serverSec}s)">cost $${c.total.toFixed(3)} <span class="meta">(AI $${c.planning.toFixed(3)} · voice $${c.voice.toFixed(3)} · server $${c.server.toFixed(3)})</span></span>`
    : j.planUsage ? ` &middot; planning $${j.planUsage.costUsd.toFixed(2)}` : '';
  const steps = j.storyboard && j.type === 'prompt' ? ` &middot; <a href="/ui/jobs/${j._id}/storyboard">view steps</a>` : '';
  const result = j.status === 'done' ? `v${j.result?.version}, ${(j.result?.sizeBytes / 1e6).toFixed(1)} MB${cost}${steps}`
    : j.status === 'planned' ? `planned${cost}${steps} <form method="post" action="/ui/record/${j._id}" style="display:inline"><button class="ghost" style="padding:3px 10px;margin-left:6px">Record it</button></form>`
    : j.status === 'failed' ? `${esc((j.error || '').split('\n')[0].slice(0, 220))}${j.failShot ? ` <a href="/ui/jobs/${j._id}/fail.jpg" target="_blank">see the screen</a>` : ''} ${/^(Claude|The AI) stopped/.test(j.error || '') && /robot|captcha|bot check|blocked|automated/i.test(j.error || '')
      // Claude stopped on purpose (robot check, bot block, login wall): retrying would hit the same wall.
      ? '<span class="meta" style="margin-left:6px">This site blocks automated browsers, so retrying won\'t help. Try a different site.</span>'
      : `<form method="post" action="/ui/retry/${j._id}" style="display:inline"><button class="ghost" style="padding:3px 10px;margin-left:6px">Retry</button></form>`}`
    : j.status === 'running' ? `${esc(friendly(j.lastEvent) || (j.stage === 'planning' ? 'The AI is planning the steps...' : 'recording...'))}`
    : j.status === 'queued' && j.pool === 'cloudrun' ? 'Waiting for Google Cloud Run: start the job in Cloud Shell (bash cloudrun/run.sh)'
    : j.status === 'queued' && j.pool === 'github' ? `${esc(friendly(j.lastEvent) || 'Waiting for a GitHub machine')} <form method="post" action="/ui/kick" style="display:inline"><button class="ghost" style="padding:3px 10px;margin-left:6px" title="Ask GitHub for machines again, e.g. if a run was cancelled">Start GitHub machines</button></form>`
    : j.status === 'queued' && j.lastEvent ? esc(friendly(j.lastEvent)) : '';
  return `<tr><td>${esc(j.storyboard?.title || j.prompt)}${j.type === 'prompt' ? ' <span class="meta">(from prompt)</span>' : ''}${RUNNERS[j.pool] ? ` <span class="meta">(${esc(RUNNERS[j.pool].short)})</span>` : ''}</td><td>${statusPill(j.status)}</td><td class="meta">${ago(j.createdAt)}</td><td class="meta">${result} <a href="/ui/jobs/${j._id}" style="white-space:nowrap">activity</a></td></tr>`;
}).join('')}
</tbody></table>` : '<p class="empty">No jobs yet.</p>'}

<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap"><h2>Video library</h2>
${videos.length ? `<form method="post" action="/ui/rerecord-all" onsubmit="return confirm('Re-record every video from its saved steps? No AI cost unless a step needs fixing; takes about 2 minutes per video.')"><button class="ghost">Re-record all</button></form>` : ''}</div>
${videos.length ? `<div class="grid">${videos.map((v) => `<div class="card vid"><a href="/v/${esc(v.slug)}"><img src="/videos/${esc(v.slug)}/thumbnail?v=${v.version}" alt=""></a>
<h3>${esc(v.title)}</h3><div class="meta">${reviewPills(v)} &middot; ${v.durationSec}s &middot; ${(v.sizeBytes / 1e6).toFixed(1)} MB &middot; ${v.narrated ? `narrated${v.voiceName ? ` by ${esc(v.voiceName.replace(/ \(.*/, ''))}` : ''}` : 'captions only'}${v.trimmedSec ? ` &middot; ${v.trimmedSec}s dead time trimmed` : ''}${v.lastCost ? ` &middot; $${v.lastCost.total.toFixed(3)}` : ''}</div>
${v.needsAttention ? `<div class="err" style="margin:10px 0 0;font-size:13px"><strong>Steps no longer work</strong> (the app probably changed): ${esc(v.needsAttention.slice(0, 200))}</div>` : ''}
${v.qa?.fixes?.length ? `<div class="meta" style="margin-top:6px;color:#5925dc">↻ Fixed automatically: ${esc(v.qa.fixes.join(' '))}</div>` : ''}
${reviewLine(v)}
${v.qa && !v.qa.ok ? `<details style="margin-top:8px"><summary style="color:#b54708">⚠ ${v.qa.warnings.length} quality warning${v.qa.warnings.length > 1 ? 's' : ''}</summary><ul class="meta" style="margin:6px 0 0;padding-left:18px">${v.qa.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : v.qa ? '<div class="meta" style="margin-top:6px;color:#067647">✓ Quality checks passed</div>' : ''}
<div class="actions"><a class="btn" href="/v/${esc(v.slug)}">Watch</a><a class="btn" href="/videos/${esc(v.slug)}/video?v=${v.version}" download="${esc(v.slug)}.mp4">MP4</a>${v.storyboard ? `<a class="btn" href="/videos/${esc(v.slug)}/sop.md?v=${v.version}" download="${esc(v.slug)}-sop.md">SOP</a>` : ''}<form method="post" action="/ui/rerecord/${esc(v.slug)}" class="rerec"><button class="ghost" title="Record again from the saved steps (no AI cost unless a step needs fixing)">Re-record</button><select name="voice" aria-label="Voice for the re-record" title="Voice for the re-record"><option value="">same voice</option>${VOICES.map((o) => `<option value="${o.id}">${esc(o.label.replace(/ \(.*/, ''))} · ${esc(o.label.match(/\((.*)\)/)?.[1] || '')}</option>`).join('')}</select></form>
${needsReview(v) ? `<a class="btn" style="background:#680BBD;color:#fff;border-color:#680BBD" href="/ui/review/${esc(v.slug)}">Review v${v.version}</a>` : v.storyboard ? `<a class="btn" href="/ui/review/${esc(v.slug)}#changes" title="Ask the AI to change or re-plan this video">Request changes</a>` : ''}</div></div>`).join('')}</div>` : '<p class="empty">No videos yet. Make one above.</p>'}
</main></body></html>`;
}

// Live view of the cloud browser: the picture refreshes several times a second; clicks on it and
// typed text are sent to the real browser. The person signs in themselves; we only save the session.
function loginPage(name) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in: ${esc(name)}</title><style>
body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f7f8fa;color:#1d2433}main{max-width:1320px;margin:0 auto;padding:18px 16px}
h1{font-size:20px;margin:0 0 4px}.meta{color:#667085;font-size:13px}.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}
input{font:inherit;padding:8px 10px;border:1px solid #d0d5dd;border-radius:8px}button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #3b5bdb;background:#fff;color:#3b5bdb;cursor:pointer}
button.main{background:#067647;border-color:#067647;color:#fff;font-weight:600}#screen{width:100%;max-width:${VIEWPORT.width}px;aspect-ratio:${VIEWPORT.width}/${VIEWPORT.height};border:1px solid #d0d5dd;border-radius:10px;cursor:pointer;background:#fff;display:block}
</style></head><body><main>
<h1>Sign in to ${esc(name)}</h1>
<p class="meta">This is the cloud browser. Click on the picture to click in it. Type into the box below and press "Type" (it goes into whichever field you last clicked). When you can see you are signed in, press <strong>Save login</strong>. Only the session is kept, never what you type.</p>
<div class="bar"><input id="url" style="flex:1;min-width:260px" placeholder="Paste a link here (e.g. a sign-in link from your email)"><button onclick="act({type:'goto',url:document.getElementById('url').value})">Go</button><button onclick="act({type:'back'})">Back</button></div>
<img id="screen" alt="Cloud browser" draggable="false">
<div class="bar"><input id="text" type="password" autocomplete="off" style="flex:1;min-width:220px" placeholder="Text to type (hidden while typing)" onkeydown="if(event.key==='Enter'){sendText(true);event.preventDefault()}">
<label class="meta"><input type="checkbox" onchange="document.getElementById('text').type=this.checked?'text':'password'"> show</label>
<button onclick="sendText(false)">Type</button><button onclick="act({type:'key',key:'Enter'})">Enter ⏎</button><button onclick="act({type:'key',key:'Tab'})">Tab</button><button onclick="act({type:'key',key:'Backspace'})">⌫</button>
<button onclick="act({type:'scroll',dy:400})">Scroll ↓</button><button onclick="act({type:'scroll',dy:-400})">Scroll ↑</button></div>
<div class="bar"><form method="post" action="/ui/logins/${esc(name)}/save"><button class="main">Save login</button></form>
<form method="post" action="/ui/logins/${esc(name)}/cancel"><button>Cancel</button></form><span class="meta" id="where"></span></div>
</main><script>
const img = document.getElementById('screen'), where = document.getElementById('where');
let busy = false, closed = false;
async function refresh() {
  if (busy || closed) return; busy = true;
  try {
    const r = await fetch('/ui/logins/${esc(name)}/shot?t=' + Date.now());
    if (r.status === 410) { closed = true; where.textContent = 'This window closed after 10 minutes without use. Go back and open it again.'; return; }
    const u = URL.createObjectURL(await r.blob()); const old = img.src; img.src = u; if (old) URL.revokeObjectURL(old);
    where.textContent = decodeURI(r.headers.get('X-Page-Url') || '');
  } finally { busy = false; }
}
async function act(a) { await fetch('/ui/logins/${esc(name)}/act', { method: 'POST', body: JSON.stringify(a) }); refresh(); }
function sendText(enter) { const t = document.getElementById('text'); act({ type: 'type', text: t.value }).then(() => enter && act({ type: 'key', key: 'Enter' })); t.value = ''; }
img.addEventListener('click', (e) => { const b = img.getBoundingClientRect(); act({ type: 'click', x: Math.round((e.clientX - b.left) * ${VIEWPORT.width} / b.width), y: Math.round((e.clientY - b.top) * ${VIEWPORT.height} / b.height) }); });
img.addEventListener('wheel', (e) => { e.preventDefault(); act({ type: 'scroll', dy: Math.sign(e.deltaY) * 300 }); }, { passive: false });
setInterval(refresh, 700); refresh();
</script></body></html>`;
}

const SAMPLE_TEXT = "Here's how to create a reimbursement in Miter. In Spend, open Reimbursements, then select Create. Enter 42.50 as the amount, and choose the job so the expense is costed correctly.";
const sampleCache = new Map();
// Voices to compare. ElevenLabs voices are tried by ID and by name, since OpenRouter doesn't list which it accepts.
const VOICE_OPTIONS = [
  { label: 'Voxtral Mini (current)', price: '$13 per million characters', model: 'mistralai/voxtral-mini-tts-3-0', voices: ['en_paul_neutral'] },
  { label: 'ElevenLabs Flash v2.5', price: '$40 per million characters', model: 'elevenlabs/eleven-flash-v2.5', voices: ['EXAVITQu4vr4xnSDxMaL', 'JBFqnCBsd6RMkjVDRZzb', 'Sarah', 'George'] },
  { label: 'ElevenLabs v4', price: '$80 per million characters', model: 'elevenlabs/eleven-v4', voices: ['EXAVITQu4vr4xnSDxMaL', 'JBFqnCBsd6RMkjVDRZzb', 'Sarah', 'George'] },
  { label: 'ElevenLabs v4 Turbo (v4 voices, half price)', price: '$40 per million characters', model: 'elevenlabs/eleven-v4-turbo', voices: ['EXAVITQu4vr4xnSDxMaL', 'Sarah'] },
  { label: 'Google Gemini 3.8 Flash TTS', price: 'per token; roughly a cent per video', model: 'google/gemini-3.8-flash-tts', voices: ['Kore', 'Aoede', 'Puck'] },
];
const VOICE_NAMES = { EXAVITQu4vr4xnSDxMaL: 'Sarah (by ID)', JBFqnCBsd6RMkjVDRZzb: 'George (by ID)', en_paul_neutral: 'Paul' };

function voicesPage(text) {
  const rows = VOICE_OPTIONS.map((o) => `<section class="card" style="margin-bottom:14px"><h2 style="margin:0 0 4px;font-size:18px">${esc(o.label)}</h2>
    <p class="meta" style="margin:0 0 10px">${esc(o.price)} · setting: <code>TTS_MODEL=${esc(o.model)}</code></p>
    ${o.voices.map((v) => `<div class="sample" data-model="${esc(o.model)}" data-voice="${esc(v)}" style="display:flex;align-items:center;gap:14px;padding:8px 0;border-top:1px solid var(--line)">
      <span style="width:150px">${esc(VOICE_NAMES[v] || v)}</span><span class="state meta">loading…</span></div>`).join('')}</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Compare voices</title>
<style>:root{--line:#e4e7ec}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f7f8fa;color:#1d2433}main{max-width:820px;margin:0 auto;padding:24px 16px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px}.meta{color:#667085;font-size:13px}code{font-size:12px;background:#f2f4f7;padding:1px 5px;border-radius:4px}</style></head>
<body><main><h1 style="font-size:22px;margin:0 0 6px">Compare voices</h1>
<p class="meta">Same sentence in each voice. Each sample costs well under a cent and is made once; replays are free. Voices that show an error aren't available under that name.</p>
<blockquote class="card" style="margin:0 0 16px">${esc(text)}</blockquote>${rows}
<p><a href="/">Back to the dashboard</a></p></main>
<script>
for (const el of document.querySelectorAll('.sample')) {
  const q = new URLSearchParams({ model: el.dataset.model, voice: el.dataset.voice, text: ${JSON.stringify(text)} });
  fetch('/ui/voice-sample?' + q).then(async (r) => {
    const st = el.querySelector('.state');
    if (!r.ok) { st.textContent = 'not available (' + (await r.text()).slice(0, 120) + ')'; return; }
    const a = document.createElement('audio'); a.controls = true; a.src = URL.createObjectURL(await r.blob());
    st.replaceWith(a);
    const c = document.createElement('code'); c.textContent = 'TTS_VOICE=' + el.dataset.voice; el.appendChild(c);
  });
}
</script></body></html>`;
}

// Returns true when it handled the request.
export async function handleDashboard(db, req, res, url) {
  const p = url.pathname;
  if (!(p === '/' || p.startsWith('/ui/'))) return false;
  if (!allowed(req, res)) return true;

  if (req.method === 'POST' && p === '/ui/make') {
    const form = await readForm(req);
    let storyboard;
    try {
      storyboard = form.custom?.trim()
        ? JSON.parse(form.custom)
        : (await storyboards()).find((s) => s.file === form.file);
      if (!storyboard?.id || !Array.isArray(storyboard.scenes)) throw new Error('A storyboard needs an "id" and a "scenes" list.');
      delete storyboard.file;
    } catch (e) {
      return redirect(res, `/?error=${encodeURIComponent(`Could not read storyboard: ${e.message}`)}`);
    }
    await db.collection('jobs').insertOne({ status: 'queued', storyboard, attempts: 0, createdAt: new Date(), source: 'dashboard', ...pickVoice(form), ...poolForNewJob() });
    await kickRunners(db).catch(() => {});
    return redirect(res);
  }
  if (req.method === 'POST' && p === '/ui/prompt') {
    const form = await readForm(req);
    const prompt = (form.prompt || '').trim().slice(0, 1000);
    if (!prompt) return redirect(res, `/?error=${encodeURIComponent('Describe the video you want first.')}`);
    let startUrl = (form.startUrl || '').trim();
    const login = cleanName(form.login || '');
    const saved = login ? await db.collection('logins').findOne({ name: login }, { projection: { url: 1 } }) : null;
    if (login && !saved) return redirect(res, `/?error=${encodeURIComponent(`Saved login "${login}" was not found.`)}`);
    if (!startUrl && saved) startUrl = saved.url;
    if (startUrl && !/^https?:\/\//i.test(startUrl)) startUrl = `https://${startUrl}`;
    await db.collection('jobs').insertOne({
      type: 'prompt', status: 'queued', prompt, startUrl: startUrl || '/#/dashboard', ...(login ? { login } : {}),
      planOnly: form.planOnly === '1', attempts: 0, createdAt: new Date(), source: 'dashboard', ...pickVoice(form), ...poolForNewJob(),
    });
    await kickRunners(db).catch(() => {});
    return redirect(res);
  }
  if (req.method === 'POST' && p.startsWith('/ui/record/')) {
    const planned = await db.collection('jobs').findOne({ _id: new ObjectId(p.split('/')[3]) });
    if (!planned?.storyboard) return redirect(res, `/?error=${encodeURIComponent('That plan was not found.')}`);
    await db.collection('jobs').insertOne({ status: 'queued', storyboard: planned.storyboard, attempts: 0, createdAt: new Date(), source: 'dashboard', ...poolForNewJob() });
    await kickRunners(db).catch(() => {});
    return redirect(res);
  }
  if (req.method === 'POST' && p.startsWith('/ui/retry/')) {
    // Re-queue a failed job. A prompt job keeps Claude's plan if it has one, so it isn't paid for twice.
    await db.collection('jobs').updateOne(
      { _id: new ObjectId(p.split('/')[3]), status: 'failed' },
      { $set: { status: 'queued', attempts: 0, createdAt: new Date() }, $unset: { error: '', stage: '', dispatchedAt: '' } },
    );
    await kickRunners(db).catch(() => {});
    return redirect(res);
  }
  if (req.method === 'POST' && p === '/ui/kick') {
    // "Start GitHub machines" for GitHub jobs that are still waiting (e.g. after a cancelled run).
    await db.collection('jobs').updateMany({ status: 'queued', pool: 'github' }, { $unset: { dispatchedAt: '' } });
    const r = await kickRunners(db);
    return redirect(res, r.error ? `/?error=${encodeURIComponent(r.error)}` : '/');
  }
  if (req.method === 'GET' && /^\/ui\/jobs\/[a-f0-9]{24}$/.test(p)) {
    const job = await db.collection('jobs').findOne({ _id: new ObjectId(p.split('/')[3]) }, { projection: { 'storyboard.scenes': 0 } });
    if (!job) return redirect(res, `/?error=${encodeURIComponent('That job was not found.')}`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(jobPage(job));
    return true;
  }
  if (req.method === 'GET' && p.startsWith('/ui/jobs/') && p.endsWith('/fail.jpg')) {
    const job = await db.collection('jobs').findOne({ _id: new ObjectId(p.split('/')[3]) }, { projection: { failShot: 1 } });
    if (!job?.failShot) { res.writeHead(404).end('No screenshot'); return true; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
    bucket(db).openDownloadStream(job.failShot).pipe(res);
    return true;
  }
  if (req.method === 'GET' && p.startsWith('/ui/jobs/') && p.endsWith('/storyboard')) {
    const job = await db.collection('jobs').findOne({ _id: new ObjectId(p.split('/')[3]) });
    res.writeHead(job?.storyboard ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(job?.storyboard || { error: 'not found' }, null, 2));
    return true;
  }
  if (req.method === 'POST' && p === '/ui/logins/start') {
    const form = await readForm(req);
    const name = cleanName(form.name);
    let url = (form.url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    try { new URL(url); } catch { return redirect(res, `/?error=${encodeURIComponent('Enter the sign-in page address, e.g. staging.example.com/login')}`); }
    if (!name) return redirect(res, `/?error=${encodeURIComponent('Give the login a name, e.g. miter-staging')}`);
    await startLive(name, url);
    return redirect(res, `/ui/logins/${name}`);
  }
  const lm = p.match(/^\/ui\/logins\/([a-z0-9-]+)(?:\/(shot|act|save|cancel|delete))?$/);
  if (lm) {
    const [, name, sub] = lm;
    if (req.method === 'POST' && sub === 'delete') { await deleteLogin(db, name); return redirect(res); }
    if (req.method === 'POST' && sub === 'cancel') { await closeLive(name); return redirect(res); }
    if (req.method === 'POST' && sub === 'save') {
      try { await saveLive(db, name); } catch (e) { return redirect(res, `/?error=${encodeURIComponent(e.message)}`); }
      return redirect(res);
    }
    if (req.method === 'GET' && sub === 'shot') {
      const shot = await liveShot(name);
      if (!shot?.jpg) { res.writeHead(410, { 'Content-Type': 'text/plain' }).end('closed'); return true; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Page-Url': encodeURI(shot.url) }).end(shot.jpg);
      return true;
    }
    if (req.method === 'POST' && sub === 'act') {
      const body = await new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e4) req.destroy(); }); req.on('end', () => r(d)); });
      try { await liveAction(name, JSON.parse(body || '{}')); res.writeHead(204).end(); } catch (e) { res.writeHead(410, { 'Content-Type': 'text/plain' }).end(e.message); }
      return true;
    }
    if (req.method === 'GET' && !sub) {
      if (!getLive(name)) return redirect(res, `/?error=${encodeURIComponent('That login window has closed. Open it again.')}`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(loginPage(name));
      return true;
    }
  }
  // Voice comparison: the same narration in several text-to-speech voices, to choose one by ear.
  // Samples are cached in memory, so replaying them doesn't cost anything.
  if (req.method === 'GET' && p === '/ui/voices') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(voicesPage(url.searchParams.get('text') || SAMPLE_TEXT));
    return true;
  }
  if (req.method === 'GET' && p === '/ui/voice-sample') {
    const model = url.searchParams.get('model') || '', voice = url.searchParams.get('voice') || '';
    const text = (url.searchParams.get('text') || SAMPLE_TEXT).slice(0, 400);
    if (!/^[a-z0-9-]+\/[a-z0-9.\-]+$/i.test(model) || !/^[\w.\- ]{1,64}$/.test(voice)) { res.writeHead(400, { 'Content-Type': 'text/plain' }).end('bad model or voice'); return true; }
    const key = `${model}|${voice}|${text}`;
    let hit = sampleCache.get(key);
    if (!hit) {
      const r = await fetch('https://openrouter.ai/api/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text, voice, response_format: 'mp3' }),
      }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
      hit = r.ok ? { ok: true, body: Buffer.from(await r.arrayBuffer()) } : { ok: false, body: `${r.status}: ${(await r.text()).slice(0, 300)}` };
      if (hit.ok) sampleCache.set(key, hit);
    }
    if (hit.ok) res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' }).end(hit.body);
    else res.writeHead(502, { 'Content-Type': 'text/plain' }).end(hit.body);
    return true;
  }
  if (req.method === 'POST' && p === '/ui/guidelines/add') {
    await addGuideline(db, (await readForm(req)).text, userOf(req));
    return redirect(res, '/ui/settings');
  }
  if (req.method === 'POST' && p.startsWith('/ui/guidelines/remove/')) {
    await removeGuideline(db, Number(p.split('/')[4]));
    return redirect(res, '/ui/settings');
  }
  if (p === '/ui/settings') {
    const models = await openRouterModels();
    if (req.method === 'POST') {
      const form = await readForm(req);
      const known = new Set(models.map((m) => m.id));
      for (const k of ['authorModel', 'repairModel', 'reviewModel']) {
        const v = (form[k] || '').trim();
        if (v && known.size && !known.has(v)) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(settingsPage(models, { err: `"${v}" isn't an OpenRouter model id. Pick one from the list (e.g. openai/gpt-6.1-terra).` }));
          return true;
        }
      }
      if (form.repairMaxTurns && !(Number(form.repairMaxTurns) >= 1 && Number(form.repairMaxTurns) <= 8)) form.repairMaxTurns = '';
      await saveSettings(db, form);
      const take = models.find((m) => m.id === repairModel());
      const warn = take && !take.images ? ` Note: ${take.id} can't read screenshots, so the takeover will only see the page's text.` : '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(settingsPage(models, { msg: `Saved. New videos will use these settings.${warn}` }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(settingsPage(models));
    return true;
  }
  if (req.method === 'GET' && p === '/ui/ai-check') {
    // Health check: gives each AI model a made-up broken step and checks it answers sensibly.
    const rows = [];
    for (const [what, role, model] of [['Planning', 'Plans each new video from your description.', authorModel()], ['Takeover', 'Fixes steps that stop working and adds the "Check your work" ending.', repairModel()], ['Editor', 'Reviews every finished video, fixes it or asks you.', reviewModel()]]) {
      const usage = newUsage(model), t = Date.now();
      try {
        const reply = parseJson(await chat([
          { role: 'system', content: 'Reply with ONLY one JSON object.' },
          { role: 'user', content: 'Accessibility snapshot:\n- link "Billing"\n- tab "Invoices"\n\nThe saved step clicked tab "Invoice list", which no longer exists. Reply {"do":"click","target":{"role":...,"name":...},"use":"instead","why":"..."}' },
        ], usage, { model, maxTokens: 300 }));
        const right = reply?.target?.name === 'Invoices';
        rows.push({ what, role, model, ok: true, right, secs: ((Date.now() - t) / 1000).toFixed(1), cost: usage.costUsd, answer: reply?.target?.name ? `Click "${reply.target.name}"` : JSON.stringify(reply) });
      } catch (e) {
        rows.push({ what, role, model, ok: false, error: e.message.slice(0, 300) });
      }
    }
    const card = (r) => `<section class="card"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><h2>${esc(r.what)} AI</h2><div class="meta">${esc(r.role)}<br><code>${esc(r.model)}</code></div></div>
      <div class="badge ${r.ok && r.right ? 'ok' : 'bad'}">${r.ok ? (r.right ? '✓ Working' : '⚠ Answered oddly') : '✕ Not working'}</div></div>
      ${r.ok ? `<p>Its answer: <strong>${esc(r.answer)}</strong> ${r.right ? '(correct)' : '(expected "Invoices")'} · ${r.secs}s · cost $${r.cost.toFixed(5)}</p>` : `<p class="err">${esc(r.error)}</p><p class="meta">${/limit/i.test(r.error) ? 'The OpenRouter key has hit its credit limit: raise it on openrouter.ai → Keys.' : 'Check the model name on the Settings page and the OpenRouter key on Render.'}</p>`}</section>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI check</title>
<style>*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f7f8fa;color:#1d2433}main{max-width:720px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 6px}h2{font-size:17px;margin:0 0 2px}
.card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:16px 18px;margin-bottom:14px}.meta{color:#667085;font-size:13px}code{font-size:12px;background:#f2f4f7;padding:1px 5px;border-radius:4px}
.badge{align-self:flex-start;font-weight:700;padding:4px 12px;border-radius:999px}.badge.ok{background:#ecfdf3;color:#067647}.badge.bad{background:#fef3f2;color:#b42318}.err{color:#b42318}a{color:#3b5bdb}</style></head><body><main>
<p class="meta"><a href="/">← Dashboard</a> · <a href="/ui/settings">Settings</a></p><h1>AI check</h1>
<p class="meta">Each AI gets a made-up problem: a saved step clicked a tab called "Invoice list" that no longer exists, and the right answer is to click "Invoices" instead. "Working" means it answered correctly. This check costs under a cent.</p>
${rows.map(card).join('')}</main></body></html>`);
    return true;
  }
  if (req.method === 'GET' && p === '/ui/voice-check') {
    // Speaks one short sentence with the configured voice, to confirm narration works without making a video.
    const res2 = narrationOn()
      ? await fetch('https://openrouter.ai/api/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.TTS_MODEL || 'mistralai/voxtral-mini-tts-3-0', input: 'This is the voice for your how-to videos.', voice: process.env.TTS_VOICE || 'en_paul_neutral', response_format: 'mp3' }),
      }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }))
      : null;
    if (!res2) res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Narration is off. Set NARRATION=on (and OPENROUTER_API_KEY) on the service.');
    else if (!res2.ok) res.writeHead(502, { 'Content-Type': 'text/plain' }).end(`Text-to-speech failed (${res2.status}): ${(await res2.text()).slice(0, 300)}`);
    else res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(Buffer.from(await res2.arrayBuffer()));
    return true;
  }
  if (req.method === 'POST' && (p.startsWith('/ui/rerecord/') || p === '/ui/rerecord-all')) {
    const form = await readForm(req);
    const n = await queueRerecords(db, p === '/ui/rerecord-all' ? {} : { slug: decodeURIComponent(p.split('/')[3]) }, 'dashboard', pickVoice(form).voice);
    if (!n) {
      const slug = p === '/ui/rerecord-all' ? null : decodeURIComponent(p.split('/')[3]);
      const busy = await db.collection('jobs').countDocuments({ status: { $in: ['queued', 'running'] }, rerecordOf: slug ? slug : { $exists: true } });
      return redirect(res, `/?error=${encodeURIComponent(busy ? (slug ? 'That video is already being re-recorded; see Jobs below.' : 'Those videos are already being re-recorded; see Jobs below.')
        : 'Nothing to re-record: older videos made before steps were saved need to be made again once.')}`);
    }
    return redirect(res);
  }
  if (req.method === 'POST' && p.startsWith('/ui/approve/')) {
    await approveVideo(db, decodeURIComponent(p.split('/')[3]), userOf(req));
    return redirect(res);
  }
  // Review page: /ui/review/:slug (+ /video, /steps/:n for the draft's files; /approve, /changes, /reject)
  if (p.startsWith('/ui/review/')) {
    const [, , , rawSlug, action, n] = p.split('/');
    const slug = decodeURIComponent(rawSlug || '');
    const v = await db.collection('videos').findOne({ slug });
    if (!v) return redirect(res, `/?error=${encodeURIComponent('That video was not found.')}`);
    if (req.method === 'GET' && action === 'video') { await streamFile(db, req, res, v.files.mp4, 'private, max-age=300'); return true; }
    if (req.method === 'GET' && action === 'steps' && v.files.steps?.[Number(n) - 1]) { await streamFile(db, req, res, v.files.steps[Number(n) - 1], 'private, max-age=300'); return true; }
    if (req.method === 'POST' && action === 'approve') {
      await approveVideo(db, slug, userOf(req));
      return redirect(res, `/?msg=${encodeURIComponent(`Approved: v${v.version} of "${v.title}" is now live.`)}`);
    }
    if (req.method === 'POST' && action === 'reject') {
      await db.collection('videos').updateOne({ slug }, { $set: { status: 'rejected', rejectedAt: new Date(), rejectedBy: userOf(req) } });
      return redirect(res, `/?msg=${encodeURIComponent(`Rejected v${v.version} of "${v.title}".${v.live ? ` v${v.live.version} stays live.` : ''}`)}`);
    }
    if (req.method === 'POST' && action === 'changes') {
      const form = await readForm(req);
      const note = (form.note || '').trim().slice(0, 1000);
      if (!note || !v.storyboard) return redirect(res, `/ui/review/${encodeURIComponent(slug)}`);
      // A double tap (or a resubmitted form) shouldn't start the same change twice.
      if (await db.collection('jobs').countDocuments({ rerecordOf: slug, status: { $in: ['queued', 'running'] } })) {
        return redirect(res, `/?error=${encodeURIComponent('Changes for that video are already being made; see Jobs below.')}`);
      }
      const usage = newUsage(repairModel());
      let revised;
      try { revised = await reviseStoryboard({ storyboard: v.storyboard, note, usage, scriptRules: SCRIPT_RULES }); } catch (e) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(reviewPage(v, { msg: `The AI couldn't apply that change: ${e.message.slice(0, 200)}` }));
        return true;
      }
      // "Remember for future videos": the general version of the request becomes a team guideline.
      const remembered = form.remember === '1' && revised.rule ? await addGuideline(db, revised.rule, userOf(req)) : false;
      const base = { rerecordOf: slug, requestedChanges: note, attempts: 0, createdAt: new Date(), source: 'review', planUsage: { costUsd: usage.costUsd, calls: usage.calls, model: usage.model }, ...poolForNewJob() };
      let summary;
      if (revised.replan) {
        // Needs different steps: plan the video again from its original request plus the feedback.
        const sb = v.storyboard;
        const basePrompt = sb.prompt || sb.title;
        const prev = sb.scenes.map((s, i) => `${i + 1}. ${s.chapter}: ${s.narration || ''}`).join('\n');
        await db.collection('jobs').insertOne({ ...base, type: 'prompt', status: 'queued', slug, basePrompt,
          prompt: `${basePrompt}\n\nThis is a new version of an existing video. A reviewer asked for: "${note}"\nThe previous version had these steps:\n${prev}\nKeep what worked and make the change the reviewer asked for.`,
          startUrl: sb.startUrl || '/', ...(sb.login ? { login: sb.login } : {}), ...(sb.voice ? { voice: sb.voice } : {}) });
        summary = `The AI will plan the video again with your feedback (${revised.reason}).`;
      } else {
        await db.collection('jobs').insertOne({ ...base, status: 'queued', storyboard: revised.storyboard });
        summary = `${revised.summary} It's being re-recorded.`;
      }
      await kickRunners(db).catch(() => {});
      await db.collection('videos').updateOne({ slug }, { $set: { status: 'changes-requested', reviewNote: { note, summary, replan: !!revised.replan, at: new Date(), by: userOf(req) } } });
      return redirect(res, `/?msg=${encodeURIComponent(`Changes requested: ${summary} It will come back for review.${remembered ? ` Saved as a team guideline: "${revised.rule}"` : ''}`)}`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(reviewPage(v));
    return true;
  }
  if (req.method === 'GET' && p === '/') {
    const [sbs, jobs, videos, logins] = await Promise.all([
      storyboards(),
      db.collection('jobs').find({}, { projection: { 'storyboard.scenes': 0, events: 0 } }).sort({ createdAt: -1 }).limit(8).toArray(),
      db.collection('videos').find({}).sort({ updatedAt: -1 }).limit(24).toArray(),
      listLogins(db),
    ]);
    const busy = jobs.some((j) => j.status === 'queued' || j.status === 'running');
    // The list query leaves out full storyboards; the steps link only needs to know one exists.
    jobs.forEach((j) => { if (j.storyboard) j.storyboard = { title: j.storyboard.title }; });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page({ sbs, jobs, videos, busy, logins, error: url.searchParams.get('error'), msg: url.searchParams.get('msg') }));
    return true;
  }
  return false;
}
