// A small web page for the demo: pick a storyboard, click "Make video", watch the job,
// play and approve the result. Protected with a password when DEMO_PASSWORD is set.
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

function allowed(req, res) {
  const pw = process.env.DEMO_PASSWORD;
  if (!pw) return true;
  const [, b64] = (req.headers.authorization || '').split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  if (pass === pw) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="docs-to-video demo"' }).end('Password required');
  return false;
}

// Re-record videos from their saved steps (no Claude planning, so under a cent each). Used after an
// app release: from the dashboard, or by POST /videos/rerecord from a deploy hook or schedule.
export async function queueRerecords(db, filter = {}, source = 'rerecord') {
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
      status: 'queued', storyboard: v.storyboard, rerecordOf: v.slug, attempts: 0, createdAt: new Date(Date.now() + i), source,
    })));
  }
  return todo.length;
}

const redirect = (res, to = '/') => res.writeHead(303, { Location: to }).end();

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
a.btn{display:inline-block;padding:7px 14px;border-radius:8px;border:1px solid var(--line);color:var(--ink);text-decoration:none;background:#fff}
.err{background:#fef3f2;border:1px solid #fecdca;color:#b42318;padding:10px 14px;border-radius:8px;margin-bottom:14px}
.empty{color:var(--muted)}
</style></head><body><main>
<h1>Docs to Video</h1><p class="sub">Describe a how-to video, or pick a ready-made storyboard. Claude plans the steps, Playwright records them in headless Chrome on Render, and videos are stored in MongoDB.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<div class="card" style="margin-bottom:16px"><form method="post" action="/ui/prompt">
<label for="prompt"><strong>Describe the video</strong></label>
<textarea id="prompt" name="prompt" class="plain" required placeholder="e.g. Search Wikipedia for Ada Lovelace and open her article"></textarea>
<div class="row" style="margin-top:12px"><div><label for="start"><strong>Start at</strong> <span class="meta">website address; leave empty to use the sample billing app</span></label>
<input id="start" name="startUrl" type="text" inputmode="url" autocomplete="off" placeholder="en.wikipedia.org"></div>
${logins.length ? `<div style="flex:0;min-width:200px"><label for="login"><strong>Signed in as</strong></label><select id="login" name="login"><option value="">Not signed in</option>${logins.map((l) => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join('')}</select></div>` : ''}
<div style="flex:0;white-space:nowrap;padding-bottom:9px"><label class="inline meta"><input type="checkbox" name="planOnly" value="1"> Plan only</label></div>
<div style="flex:0"><button type="submit">Plan and record</button></div></div>
<p class="meta">Claude works out the clicks on the real site, then the video is recorded. Takes about 2–4 minutes. Sites that show a robot check won't work, and it never types passwords or completes purchases. For apps that need a login (like Miter staging), add a saved login below and pick it under "Signed in as"; leave "Start at" empty to start where you logged in.</p>
</form></div>
<div class="card"><form method="post" action="/ui/make"><div class="row"><div>
<label for="sb"><strong>Or pick a ready-made storyboard</strong></label>
<select id="sb" name="file">${sbs.map((s) => `<option value="${esc(s.file)}">${esc(s.title)} (${s.scenes.length} steps)</option>`).join('')}</select></div>
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
  const cost = c ? ` &middot; <span title="Claude planning $${c.planning.toFixed(4)} · voice $${c.voice.toFixed(4)} (${c.voiceChars} characters) · server $${c.server.toFixed(4)} (${c.serverSec}s)">cost $${c.total.toFixed(3)} <span class="meta">(Claude $${c.planning.toFixed(3)} · voice $${c.voice.toFixed(3)} · server $${c.server.toFixed(3)})</span></span>`
    : j.planUsage ? ` &middot; planning $${j.planUsage.costUsd.toFixed(2)}` : '';
  const steps = j.storyboard && j.type === 'prompt' ? ` &middot; <a href="/ui/jobs/${j._id}/storyboard">view steps</a>` : '';
  const result = j.status === 'done' ? `v${j.result?.version}, ${(j.result?.sizeBytes / 1e6).toFixed(1)} MB${cost}${steps}`
    : j.status === 'planned' ? `planned${cost}${steps} <form method="post" action="/ui/record/${j._id}" style="display:inline"><button class="ghost" style="padding:3px 10px;margin-left:6px">Record it</button></form>`
    : j.status === 'failed' ? `${esc((j.error || '').split('\n')[0].slice(0, 220))}${j.failShot ? ` <a href="/ui/jobs/${j._id}/fail.jpg" target="_blank">see the screen</a>` : ''} ${/^Claude stopped/.test(j.error || '')
      // Claude stopped on purpose (robot check, bot block, login wall): retrying would hit the same wall.
      ? '<span class="meta" style="margin-left:6px">This site blocks automated browsers, so retrying won\'t help. Try a different site.</span>'
      : `<form method="post" action="/ui/retry/${j._id}" style="display:inline"><button class="ghost" style="padding:3px 10px;margin-left:6px">Retry</button></form>`}`
    : j.status === 'running' ? `${j.stage === 'planning' ? 'Claude is planning the steps...' : 'recording...'}` : '';
  return `<tr><td>${esc(j.storyboard?.title || j.prompt)}${j.type === 'prompt' ? ' <span class="meta">(from prompt)</span>' : ''}</td><td>${statusPill(j.status)}</td><td class="meta">${ago(j.createdAt)}</td><td class="meta">${result}</td></tr>`;
}).join('')}
</tbody></table>` : '<p class="empty">No jobs yet.</p>'}

<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap"><h2>Video library</h2>
${videos.length ? `<form method="post" action="/ui/rerecord-all" onsubmit="return confirm('Re-record every video from its saved steps? No Claude cost; takes about 2 minutes per video.')"><button class="ghost">Re-record all</button></form>` : ''}</div>
${videos.length ? `<div class="grid">${videos.map((v) => `<div class="card vid"><a href="/v/${esc(v.slug)}"><img src="/videos/${esc(v.slug)}/thumbnail?v=${v.version}" alt=""></a>
<h3>${esc(v.title)}</h3><div class="meta">${statusPill(v.status)} &nbsp;v${v.version} &middot; ${v.durationSec}s &middot; ${(v.sizeBytes / 1e6).toFixed(1)} MB &middot; ${v.narrated ? 'narrated' : 'captions only'}${v.trimmedSec ? ` &middot; ${v.trimmedSec}s dead time trimmed` : ''}${v.lastCost ? ` &middot; $${v.lastCost.total.toFixed(3)}` : ''}</div>
${v.needsAttention ? `<div class="err" style="margin:10px 0 0;font-size:13px"><strong>Steps no longer work</strong> (the app probably changed): ${esc(v.needsAttention.slice(0, 200))}</div>` : ''}
${v.qa?.fixes?.length ? `<div class="meta" style="margin-top:6px;color:#5925dc">↻ Fixed automatically: ${esc(v.qa.fixes.join(' '))}</div>` : ''}
${v.qa && !v.qa.ok ? `<details style="margin-top:8px"><summary style="color:#b54708">⚠ ${v.qa.warnings.length} quality warning${v.qa.warnings.length > 1 ? 's' : ''}</summary><ul class="meta" style="margin:6px 0 0;padding-left:18px">${v.qa.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : v.qa ? '<div class="meta" style="margin-top:6px;color:#067647">✓ Quality checks passed</div>' : ''}
<div class="actions"><a class="btn" href="/v/${esc(v.slug)}">Watch</a><a class="btn" href="/videos/${esc(v.slug)}/video?v=${v.version}" download="${esc(v.slug)}.mp4">MP4</a>${v.storyboard ? `<a class="btn" href="/videos/${esc(v.slug)}/sop.md?v=${v.version}" download="${esc(v.slug)}-sop.md">SOP</a>` : ''}<form method="post" action="/ui/rerecord/${esc(v.slug)}"><button class="ghost" title="Record again from the saved steps (no Claude cost)">Re-record</button></form>
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
    await db.collection('jobs').insertOne({ status: 'queued', storyboard, attempts: 0, createdAt: new Date(), source: 'dashboard' });
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
      planOnly: form.planOnly === '1', attempts: 0, createdAt: new Date(), source: 'dashboard',
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
    const n = await queueRerecords(db, p === '/ui/rerecord-all' ? {} : { slug: decodeURIComponent(p.split('/')[3]) }, 'dashboard');
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
