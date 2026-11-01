// A small web page for the demo: pick a storyboard, click "Make video", watch the job,
// play and approve the result. Protected with a password when DEMO_PASSWORD is set.
import { authorModel, repairModel, chat, parseJson, newUsage } from './ai.mjs';
import { SETTINGS, setting, saveSettings } from './settings.mjs';
import crypto from 'node:crypto';
import { VOICES, defaultVoice, isVoice, perVideo } from './voices.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { bucket } from './store.mjs';
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
      status: 'queued', storyboard: v.storyboard, rerecordOf: v.slug, attempts: 0, createdAt: new Date(Date.now() + i), source, ...(voice ? { voice } : {}),
    })));
  }
  return todo.length;
}

const redirect = (res, to = '/') => res.writeHead(303, { Location: to }).end();

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
<datalist id="models">${models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} · ${esc(price(m))}</option>`).join('')}</datalist>
<p class="meta" style="margin:12px 0 0">Type to search ${models.length || 'OpenRouter\'s'} models, e.g. <code>gpt-6.1-terra</code> or <code>claude</code>. <a href="/ui/ai-check" target="_blank">Test the models in use</a> (asks each one a small question).</p>
</section>
<section class="card"><h2>AI takeover</h2>
<div class="row"><div><label>When a step stops working</label>${sel('repair', [['', `Render / default (${cur.repair.from === 'settings' ? 'on' : cur.repair.value})`], ['on', 'Let the AI fix it'], ['off', 'Stop and report the error']], val('repair'))}
<span class="price">${note('repair')}</span></div>
<div><label>Tries per broken step</label><input name="repairMaxTurns" type="number" min="1" max="8" value="${esc(val('repairMaxTurns'))}" placeholder="${esc(cur.repairMaxTurns.value)}"><span class="price">${note('repairMaxTurns')}</span></div></div>
<label>Thinking effort (OpenAI GPT models only)</label>${sel('reasoningEffort', [['', `Render / default (${cur.reasoningEffort.from === 'settings' ? 'low' : cur.reasoningEffort.value})`], ['low', 'Low — fastest and cheapest'], ['medium', 'Medium'], ['high', 'High — slowest, for tricky screens']], val('reasoningEffort'))}
<span class="price">${note('reasoningEffort')}</span>
</section>
<section class="card"><h2>Voice</h2>
<label>Default voice for new videos</label>${sel('voice', [['', 'Render setting (TTS_MODEL / TTS_VOICE)'], ...VOICES.map((o) => [o.id, `${o.label} · ${perVideo(o)}`])], val('voice'))}
<span class="price">Preselected in the request forms; you can still pick another voice per video. In use: <strong>${esc(defaultVoice().label)}</strong>. <a href="/ui/voices">Listen to the voices</a></span>
</section>
<button type="submit">Save settings</button>
</form></main></body></html>`;
}

// Voice dropdown for the request forms; the service default is preselected.
const pickVoice = (form) => (isVoice(form.voice) ? { voice: form.voice } : {});
function voiceSelect(id) {
  const def = defaultVoice().id;
  return `<div style="flex:0;min-width:230px"><label for="${id}"><strong>Voice</strong> <a class="meta" href="/ui/voices">listen</a></label><select id="${id}" name="voice">${VOICES.map((o) =>
    `<option value="${o.id}"${o.id === def ? ' selected' : ''}>${esc(o.label)} · ${esc(perVideo(o))}</option>`).join('')}</select></div>`;
}

function page({ sbs, jobs, videos, busy, error, logins = [] }) {
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
${error ? `<div class="err">${esc(error)}</div>` : ''}
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
    : j.status === 'failed' ? `${esc((j.error || '').split('\n')[0].slice(0, 220))}${j.failShot ? ` <a href="/ui/jobs/${j._id}/fail.jpg" target="_blank">see the screen</a>` : ''} ${/^(Claude|The AI) stopped/.test(j.error || '')
      // Claude stopped on purpose (robot check, bot block, login wall): retrying would hit the same wall.
      ? '<span class="meta" style="margin-left:6px">This site blocks automated browsers, so retrying won\'t help. Try a different site.</span>'
      : `<form method="post" action="/ui/retry/${j._id}" style="display:inline"><button class="ghost" style="padding:3px 10px;margin-left:6px">Retry</button></form>`}`
    : j.status === 'running' ? `${j.stage === 'planning' ? 'The AI is planning the steps...' : 'recording...'}` : '';
  return `<tr><td>${esc(j.storyboard?.title || j.prompt)}${j.type === 'prompt' ? ' <span class="meta">(from prompt)</span>' : ''}</td><td>${statusPill(j.status)}</td><td class="meta">${ago(j.createdAt)}</td><td class="meta">${result}</td></tr>`;
}).join('')}
</tbody></table>` : '<p class="empty">No jobs yet.</p>'}

<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap"><h2>Video library</h2>
${videos.length ? `<form method="post" action="/ui/rerecord-all" onsubmit="return confirm('Re-record every video from its saved steps? No AI cost unless a step needs fixing; takes about 2 minutes per video.')"><button class="ghost">Re-record all</button></form>` : ''}</div>
${videos.length ? `<div class="grid">${videos.map((v) => `<div class="card vid"><a href="/v/${esc(v.slug)}"><img src="/videos/${esc(v.slug)}/thumbnail?v=${v.version}" alt=""></a>
<h3>${esc(v.title)}</h3><div class="meta">${statusPill(v.status)} &nbsp;v${v.version} &middot; ${v.durationSec}s &middot; ${(v.sizeBytes / 1e6).toFixed(1)} MB &middot; ${v.narrated ? `narrated${v.voiceName ? ` by ${esc(v.voiceName.replace(/ \(.*/, ''))}` : ''}` : 'captions only'}${v.trimmedSec ? ` &middot; ${v.trimmedSec}s dead time trimmed` : ''}${v.lastCost ? ` &middot; $${v.lastCost.total.toFixed(3)}` : ''}</div>
${v.needsAttention ? `<div class="err" style="margin:10px 0 0;font-size:13px"><strong>Steps no longer work</strong> (the app probably changed): ${esc(v.needsAttention.slice(0, 200))}</div>` : ''}
${v.qa?.fixes?.length ? `<div class="meta" style="margin-top:6px;color:#5925dc">↻ Fixed automatically: ${esc(v.qa.fixes.join(' '))}</div>` : ''}
${v.qa && !v.qa.ok ? `<details style="margin-top:8px"><summary style="color:#b54708">⚠ ${v.qa.warnings.length} quality warning${v.qa.warnings.length > 1 ? 's' : ''}</summary><ul class="meta" style="margin:6px 0 0;padding-left:18px">${v.qa.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : v.qa ? '<div class="meta" style="margin-top:6px;color:#067647">✓ Quality checks passed</div>' : ''}
<div class="actions"><a class="btn" href="/v/${esc(v.slug)}">Watch</a><a class="btn" href="/videos/${esc(v.slug)}/video?v=${v.version}" download="${esc(v.slug)}.mp4">MP4</a>${v.storyboard ? `<a class="btn" href="/videos/${esc(v.slug)}/sop.md?v=${v.version}" download="${esc(v.slug)}-sop.md">SOP</a>` : ''}<form method="post" action="/ui/rerecord/${esc(v.slug)}" class="rerec"><button class="ghost" title="Record again from the saved steps (no AI cost unless a step needs fixing)">Re-record</button><select name="voice" aria-label="Voice for the re-record" title="Voice for the re-record"><option value="">same voice</option>${VOICES.map((o) => `<option value="${o.id}">${esc(o.label.replace(/ \(.*/, ''))} · ${esc(o.label.match(/\((.*)\)/)?.[1] || '')}</option>`).join('')}</select></form>
${v.status !== 'approved' ? `<form method="post" action="/ui/approve/${esc(v.slug)}"><button class="ghost">Approve</button></form>` : ''}</div></div>`).join('')}</div>` : '<p class="empty">No videos yet. Make one above.</p>'}
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
    await db.collection('jobs').insertOne({ status: 'queued', storyboard, attempts: 0, createdAt: new Date(), source: 'dashboard', ...pickVoice(form) });
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
      planOnly: form.planOnly === '1', attempts: 0, createdAt: new Date(), source: 'dashboard', ...pickVoice(form),
    });
    return redirect(res);
  }
  if (req.method === 'POST' && p.startsWith('/ui/record/')) {
    const planned = await db.collection('jobs').findOne({ _id: new ObjectId(p.split('/')[3]) });
    if (!planned?.storyboard) return redirect(res, `/?error=${encodeURIComponent('That plan was not found.')}`);
    await db.collection('jobs').insertOne({ status: 'queued', storyboard: planned.storyboard, attempts: 0, createdAt: new Date(), source: 'dashboard' });
    return redirect(res);
  }
  if (req.method === 'POST' && p.startsWith('/ui/retry/')) {
    // Re-queue a failed job. A prompt job keeps Claude's plan if it has one, so it isn't paid for twice.
    await db.collection('jobs').updateOne(
      { _id: new ObjectId(p.split('/')[3]), status: 'failed' },
      { $set: { status: 'queued', attempts: 0, createdAt: new Date() }, $unset: { error: '', stage: '' } },
    );
    return redirect(res);
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
  if (p === '/ui/settings') {
    const models = await openRouterModels();
    if (req.method === 'POST') {
      const form = await readForm(req);
      const known = new Set(models.map((m) => m.id));
      for (const k of ['authorModel', 'repairModel']) {
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
    // Asks each AI model one tiny question in the same JSON format the planner and takeover use,
    // to confirm the model id works on OpenRouter before relying on it.
    const out = [];
    for (const [what, model] of [['Planning', authorModel()], ['Takeover', repairModel()]]) {
      const usage = newUsage(model), t = Date.now();
      try {
        const reply = parseJson(await chat([
          { role: 'system', content: 'Reply with ONLY one JSON object.' },
          { role: 'user', content: 'Accessibility snapshot:\n- link "Billing"\n- tab "Invoices"\n\nThe saved step clicked tab "Invoice list", which no longer exists. Reply {"do":"click","target":{"role":...,"name":...},"use":"instead","why":"..."}' },
        ], usage, { model, maxTokens: 300 }));
        out.push(`${what}: ${model}\n  OK in ${((Date.now() - t) / 1000).toFixed(1)}s, cost $${usage.costUsd.toFixed(5)}\n  reply: ${JSON.stringify(reply)}`);
      } catch (e) {
        out.push(`${what}: ${model}\n  FAILED: ${e.message.slice(0, 300)}`);
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(out.join('\n\n'));
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
    if (!n) return redirect(res, `/?error=${encodeURIComponent('Nothing to re-record: older videos made before steps were saved need to be made again once.')}`);
    return redirect(res);
  }
  if (req.method === 'POST' && p.startsWith('/ui/approve/')) {
    await db.collection('videos').updateOne({ slug: decodeURIComponent(p.split('/')[3]) }, { $set: { status: 'approved', approvedAt: new Date() } });
    return redirect(res);
  }
  if (req.method === 'GET' && p === '/') {
    const [sbs, jobs, videos, logins] = await Promise.all([
      storyboards(),
      db.collection('jobs').find({}, { projection: { 'storyboard.scenes': 0 } }).sort({ createdAt: -1 }).limit(8).toArray(),
      db.collection('videos').find({}).sort({ updatedAt: -1 }).limit(24).toArray(),
      listLogins(db),
    ]);
    const busy = jobs.some((j) => j.status === 'queued' || j.status === 'running');
    // The list query leaves out full storyboards; the steps link only needs to know one exists.
    jobs.forEach((j) => { if (j.storyboard) j.storyboard = { title: j.storyboard.title }; });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page({ sbs, jobs, videos, busy, logins, error: url.searchParams.get('error') }));
    return true;
  }
  return false;
}
