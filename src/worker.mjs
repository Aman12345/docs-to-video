// video-worker: takes queued jobs from MongoDB one at a time, records the video,
// and stores the result back in MongoDB. In production it runs as its own Render
// background worker; in the demo, src/server.mjs runs it inside the web service.
import { getDb, ensureIndexes, closeDb, bucket } from './store.mjs';
import { makeVideo } from './pipeline.mjs';
import { authorStoryboard } from './author.mjs';
import { startDemoApp } from './demo-server.mjs';
import { loadLogin } from './logins.mjs';

const POLL_MS = 3000;
const STALE_MS = 30 * 60 * 1000; // a job "running" this long belonged to a worker that died
const HEARTBEAT_MS = 15 * 1000;
const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What each video cost, so the dashboard shows real numbers, not estimates.
// Prices (Nov 2026): OpenRouter voice $13 per million characters; Render 1 CPU / 2 GB server $25/month
// (charged by the second, so the share used by one job = its seconds x $25 / seconds in a month).
const VOICE_USD_PER_CHAR = Number(process.env.TTS_USD_PER_MCHAR || 13) / 1e6;
const SERVER_USD_PER_SEC = Number(process.env.SERVER_USD_PER_MONTH || 25) / (730 * 3600);
function costOf({ planUsd = 0, voiceChars = 0, serverSec = 0 }) {
  const c = { planning: planUsd, voice: voiceChars * VOICE_USD_PER_CHAR, server: serverSec * SERVER_USD_PER_SEC };
  c.total = c.planning + c.voice + c.server;
  for (const k of Object.keys(c)) c[k] = Math.round(c[k] * 1e5) / 1e5;
  return { ...c, voiceChars, serverSec: Math.round(serverSec) };
}

export async function startWorker() {
  const db = await getDb();
  await ensureIndexes(db);
  const jobs = db.collection('jobs');

  // APP_URL is the app to film (e.g. the Miter sandbox). Without it, use the bundled sample app.
  let demo;
  if (!process.env.APP_URL) demo = await startDemoApp(4173);
  const baseUrl = process.env.APP_URL || demo.url;
  console.log(`video-worker ready; recording against ${baseUrl}`);

  const state = { stopping: false, current: null };
  const loop = (async () => {
    while (!state.stopping) {
      // Jobs whose worker stopped checking in (server restarted or crashed) go back to the queue.
      // A running job checks in every 15 s; jobs from before check-ins existed use startedAt.
      const now = Date.now();
      await jobs.updateMany(
        { status: 'running', $or: [
          { heartbeatAt: { $lt: new Date(now - HEARTBEAT_STALE_MS) } },
          { heartbeatAt: { $exists: false }, startedAt: { $lt: new Date(now - 5 * 60 * 1000) } },
          { startedAt: { $lt: new Date(now - STALE_MS) }, heartbeatAt: { $exists: false } },
        ] },
        { $set: { status: 'queued', stage: null, note: 'restarted after the server stopped' }, $inc: { attempts: -1 }, $unset: { heartbeatAt: '' } },
      );
      // Atomically claim the oldest queued job, so two workers never take the same one.
      const job = await jobs.findOneAndUpdate(
        { status: 'queued' },
        { $set: { status: 'running', startedAt: new Date() }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      );
      if (!job) { await sleep(POLL_MS); continue; }

      state.current = job._id;
      const beat = setInterval(() => jobs.updateOne({ _id: job._id, status: 'running' }, { $set: { heartbeatAt: new Date() } }).catch(() => {}), HEARTBEAT_MS);
      await jobs.updateOne({ _id: job._id }, { $set: { heartbeatAt: new Date() } });
      const log = (msg) => console.log(`[job ${job._id}] ${msg}`);
      const jobStart = Date.now();
      log(`started: ${job.storyboard?.title || job.prompt}`);
      try {
        let storyboard = job.storyboard;
        // Saved login (e.g. Miter staging): every browser for this job starts already signed in.
        const loginName = job.login || storyboard?.login;
        const storageState = loginName ? (await loadLogin(db, loginName)).storageState : undefined;
        // Prompt jobs: Claude plans the storyboard first (skipped on retry if already planned).
        if (job.type === 'prompt' && !storyboard) {
          await jobs.updateOne({ _id: job._id }, { $set: { stage: 'planning' } });
          const plan = await authorStoryboard({ prompt: job.prompt, startUrl: job.startUrl, baseUrl, storageState, log });
          storyboard = plan.storyboard;
          if (loginName) storyboard.login = loginName;
          await jobs.updateOne({ _id: job._id }, { $set: { storyboard, planUsage: plan.usage } });
          if (job.planOnly) {
            const cost = costOf({ planUsd: plan.usage.costUsd, serverSec: (Date.now() - jobStart) / 1000 });
            await jobs.updateOne({ _id: job._id }, { $set: { status: 'planned', stage: null, finishedAt: new Date(), cost } });
            state.current = null;
            log('planned (not recording)');
            continue;
          }
        }
        await jobs.updateOne({ _id: job._id }, { $set: { stage: 'recording' } });
        const saved = await makeVideo({ storyboard, baseUrl, jobId: job._id, storageState, log });
        const fresh = await jobs.findOne({ _id: job._id }, { projection: { planUsage: 1 } });
        // Planning is counted once, on the job that planned it ("Record it" jobs reuse a paid-for plan).
        const cost = costOf({ planUsd: fresh?.planUsage?.costUsd || 0, voiceChars: saved.voiceChars, serverSec: (Date.now() - jobStart) / 1000 });
        await jobs.updateOne({ _id: job._id }, { $set: { status: 'done', stage: null, finishedAt: new Date(), result: saved, cost } });
        await db.collection('videos').updateOne({ slug: saved.slug }, { $set: { lastCost: cost } });
        state.current = null;
        log(`done; cost $${cost.total.toFixed(4)} (Claude planning $${cost.planning.toFixed(4)}, voice $${cost.voice.toFixed(4)} for ${cost.voiceChars} chars, server $${cost.server.toFixed(4)} for ${cost.serverSec}s)`);
      } catch (err) {
        if (state.stopping) { state.current = null; continue; } // shutting down: the job was handed back already
        // Don't retry when Claude was blocked (CAPTCHA, login wall) or the key is missing.
        // Save what the screen looked like when it failed, so the dashboard can show it.
        let failShot;
        if (err.screenshot) {
          const up = bucket(db).openUploadStream(`fail-${job._id}.jpg`, { metadata: { contentType: 'image/jpeg', jobId: job._id } });
          await new Promise((ok) => { up.on('finish', ok); up.on('error', ok); up.end(err.screenshot); });
          failShot = up.id;
        }
        const retry = job.attempts < 2 && !/Claude stopped|OPENROUTER_API_KEY|did not find any steps|Saved login/.test(err.message);
        await jobs.updateOne({ _id: job._id }, { $set: { status: retry ? 'queued' : 'failed', error: err.message.slice(0, 2000), ...(failShot ? { failShot } : {}) } });
        state.current = null;
        log(`failed (${retry ? 'will retry' : 'giving up'}): ${err.message.split('\n')[0]}`);
        // A re-record that fails usually means the app changed under the saved steps: flag the video.
        if (!retry && job.rerecordOf) {
          await db.collection('videos').updateOne({ slug: job.rerecordOf }, { $set: { needsAttention: err.message.split('\n')[0].slice(0, 300), needsAttentionAt: new Date() } });
        }
      } finally {
        clearInterval(beat);
      }
    }
    demo?.server.close();
  })();

  // On a deploy or restart, Render stops this instance after a short grace period, far shorter than a
  // long Miter AI video. So hand the running job straight back to the queue (without counting it as a
  // failed attempt); the new instance picks it up within seconds.
  const handBack = async () => {
    state.stopping = true;
    if (!state.current) return;
    await jobs.updateOne({ _id: state.current, status: 'running' }, { $set: { status: 'queued', stage: null, note: 'restarted after a server update' }, $inc: { attempts: -1 } });
    console.log(`[job ${state.current}] handed back to the queue (server restarting)`);
  };
  return { stop: async () => { state.stopping = true; await loop; }, handBack };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = await startWorker();
  process.on('SIGTERM', async () => {
    console.log('SIGTERM: handing the current job back to the queue, then exiting');
    await worker.handBack();
    await closeDb();
    process.exit(0);
  });
}
