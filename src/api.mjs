// video-api: the one front door for Slack, the support agent and client share links.
// Runs as a Render web service. Videos stream straight out of MongoDB GridFS.
import http from 'node:http';
import { ObjectId } from 'mongodb';
import { getDb, ensureIndexes, bucket } from './store.mjs';
import { handleDashboard } from './dashboard.mjs';

const PORT = Number(process.env.PORT) || 10000;
const API_KEY = process.env.API_KEY; // required for write and search routes when set
const PUBLIC_URL = process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`;

const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body, null, 2));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const readBody = (req) => new Promise((resolve, reject) => {
  let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
});

// Streams a GridFS file, honouring HTTP Range requests so browsers can seek in the video.
async function streamFile(db, req, res, fileId, cache = 'public, max-age=300') {
  const file = await db.collection('videofiles.files').findOne({ _id: fileId });
  if (!file) return json(res, 404, { error: 'file not found' });
  const type = file.metadata?.contentType || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), file.length - 1) : file.length - 1;
    if (start > end) return res.writeHead(416, { 'Content-Range': `bytes */${file.length}` }).end();
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${file.length}`, 'Cache-Control': cache });
    return bucket(db).openDownloadStream(fileId, { start, end: end + 1 }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': file.length, 'Cache-Control': cache });
  bucket(db).openDownloadStream(fileId).pipe(res);
}

function sharePage(v) {
  const chapters = v.chapters.map((c) => `<li><a href="#t=${c.startSec}" onclick="document.querySelector('video').currentTime=${c.startSec};return false">${esc(c.title)}</a> <span>${Math.floor(c.startSec / 60)}:${String(Math.floor(c.startSec % 60)).padStart(2, '0')}</span></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(v.title)}</title><style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f7f8fa;color:#1d2433}
main{max-width:960px;margin:0 auto;padding:24px 16px}video{width:100%;border-radius:12px;background:#111827}
h1{font-size:24px;margin:0 0 6px}p{color:#667085;margin:0 0 18px}ol{padding-left:20px}li span{color:#667085;font-size:14px}</style></head>
<body><main><h1>${esc(v.title)}</h1><p>${esc(v.description)}</p>
<video controls preload="metadata" poster="/videos/${v.slug}/thumbnail?v=${v.version}" src="/videos/${v.slug}/video?v=${v.version}"><track kind="captions" srclang="en" label="English" src="/videos/${v.slug}/captions?v=${v.version}"></video>
<h2 style="font-size:17px">Steps</h2><ol>${chapters}</ol>
<p style="font-size:13px;margin-top:18px">Keyboard: Space or K to play/pause, ← → to skip 5 seconds, F for full screen.</p></main>
<script>
// Space normally scrolls the page unless the player has focus; make it control the video instead.
const vid = document.querySelector('video');
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input,textarea,select,button') || e.target === vid || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'k') { vid.paused ? vid.play() : vid.pause(); }
  else if (k === 'arrowright') vid.currentTime = Math.min(vid.duration || 0, vid.currentTime + 5);
  else if (k === 'arrowleft') vid.currentTime = Math.max(0, vid.currentTime - 5);
  else if (k === 'f') { document.fullscreenElement ? document.exitFullscreen() : vid.requestFullscreen?.(); }
  else return;
  e.preventDefault();
});
document.querySelectorAll('ol a').forEach((a) => a.addEventListener('click', () => vid.play()));
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const db = await getDb();
    const url = new URL(req.url, PUBLIC_URL);
    const parts = url.pathname.split('/').filter(Boolean);
    // Write and search routes need API_KEY (Bearer) if set, otherwise the demo password (Basic auth).
    const auth = req.headers.authorization || '';
    const demoPw = process.env.DEMO_PASSWORD;
    const basicPw = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString().split(':').slice(1).join(':') : null;
    const authed = API_KEY ? auth === `Bearer ${API_KEY}` : demoPw ? basicPw === demoPw : true;

    if (url.pathname === '/health') return json(res, 200, { ok: true });
    if (await handleDashboard(db, req, res, url)) return;

    // Queue a new video. In production the Slack bot or the support agent calls this.
    if (req.method === 'POST' && url.pathname === '/jobs') {
      if (!authed) return json(res, 401, { error: 'unauthorized' });
      const { storyboard } = await readBody(req);
      if (!storyboard?.id || !Array.isArray(storyboard.scenes)) return json(res, 400, { error: 'storyboard with id and scenes required' });
      const { insertedId } = await db.collection('jobs').insertOne({ status: 'queued', storyboard, attempts: 0, createdAt: new Date() });
      return json(res, 202, { jobId: insertedId, status: 'queued' });
    }
    // Describe a video in plain English; Claude plans the storyboard, then it's recorded.
    if (req.method === 'POST' && url.pathname === '/prompts') {
      if (!authed) return json(res, 401, { error: 'unauthorized' });
      const { prompt, startUrl, planOnly } = await readBody(req);
      if (!prompt?.trim()) return json(res, 400, { error: 'prompt required' });
      const { insertedId } = await db.collection('jobs').insertOne({
        type: 'prompt', status: 'queued', prompt: prompt.trim().slice(0, 1000), startUrl: startUrl || '/#/dashboard',
        planOnly: !!planOnly, attempts: 0, createdAt: new Date(), source: 'api',
      });
      return json(res, 202, { jobId: insertedId, status: 'queued' });
    }
    if (req.method === 'GET' && parts[0] === 'jobs' && parts[1]) {
      const job = await db.collection('jobs').findOne({ _id: new ObjectId(parts[1]) }, { projection: { storyboard: 0 } });
      return job ? json(res, 200, job) : json(res, 404, { error: 'job not found' });
    }

    // Search the library: what the support agent's search_videos tool calls.
    if (req.method === 'GET' && url.pathname === '/search') {
      if (!authed) return json(res, 401, { error: 'unauthorized' });
      const q = url.searchParams.get('q') || '';
      const status = url.searchParams.get('status') || 'approved';
      const hits = await db.collection('videos')
        .find({ $text: { $search: q }, status }, { projection: { score: { $meta: 'textScore' }, slug: 1, title: 1, description: 1, durationSec: 1, chapters: 1 } })
        .sort({ score: { $meta: 'textScore' } }).limit(Number(url.searchParams.get('limit')) || 5).toArray();
      return json(res, 200, hits.map((h) => ({ ...h, shareUrl: `${PUBLIC_URL}/v/${h.slug}`, thumbnailUrl: `${PUBLIC_URL}/videos/${h.slug}/thumbnail` })));
    }

    if (req.method === 'POST' && parts[0] === 'videos' && parts[2] === 'approve') {
      if (!authed) return json(res, 401, { error: 'unauthorized' });
      const r = await db.collection('videos').updateOne({ slug: parts[1] }, { $set: { status: 'approved', approvedAt: new Date() } });
      return json(res, r.matchedCount ? 200 : 404, { slug: parts[1], status: r.matchedCount ? 'approved' : 'not found' });
    }

    if (req.method === 'GET' && (parts[0] === 'videos' || parts[0] === 'v') && parts[1]) {
      const v = await db.collection('videos').findOne({ slug: parts[1] });
      if (!v) return json(res, 404, { error: 'video not found' });
      if (parts[0] === 'v') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(sharePage(v));
      if (!parts[2]) return json(res, 200, v);
      const map = { video: 'mp4', thumbnail: 'thumbnail', captions: 'captions' };
      if (map[parts[2]]) return streamFile(db, req, res, v.files[map[parts[2]]]);
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

export async function startApi() {
  await ensureIndexes(await getDb());
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`video-api listening on ${PORT}`);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) await startApi();
