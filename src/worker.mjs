// video-worker: takes queued jobs from MongoDB one at a time, records the video,
// and stores the result back in MongoDB. In production it runs as its own Render
// background worker; in the demo, src/server.mjs runs it inside the web service.
import { getDb, ensureIndexes, closeDb } from './store.mjs';
import { makeVideo } from './pipeline.mjs';
import { authorStoryboard } from './author.mjs';
import { startDemoApp } from './demo-server.mjs';
import { loadLogin } from './logins.mjs';

const POLL_MS = 3000;
const STALE_MS = 30 * 60 * 1000; // a job "running" this long belonged to a worker that died
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startWorker() {
  const db = await getDb();
  await ensureIndexes(db);
  const jobs = db.collection('jobs');

  // APP_URL is the app to film (e.g. the Miter sandbox). Without it, use the bundled sample app.
  let demo;
  if (!process.env.APP_URL) demo = await startDemoApp(4173);
  const baseUrl = process.env.APP_URL || demo.url;
  console.log(`video-worker ready; recording against ${baseUrl}`);

  const state = { stopping: false };
  const loop = (async () => {
    while (!state.stopping) {
      await jobs.updateMany(
        { status: 'running', startedAt: { $lt: new Date(Date.now() - STALE_MS) } },
        { $set: { status: 'queued' } },
      );
      // Atomically claim the oldest queued job, so two workers never take the same one.
      const job = await jobs.findOneAndUpdate(
        { status: 'queued' },
        { $set: { status: 'running', startedAt: new Date() }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      );
      if (!job) { await sleep(POLL_MS); continue; }

      const log = (msg) => console.log(`[job ${job._id}] ${msg}`);
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
            await jobs.updateOne({ _id: job._id }, { $set: { status: 'planned', stage: null, finishedAt: new Date() } });
            log('planned (not recording)');
            continue;
          }
        }
        await jobs.updateOne({ _id: job._id }, { $set: { stage: 'recording' } });
        const saved = await makeVideo({ storyboard, baseUrl, jobId: job._id, storageState, log });
        await jobs.updateOne({ _id: job._id }, { $set: { status: 'done', stage: null, finishedAt: new Date(), result: saved } });
        log('done');
      } catch (err) {
        // Don't retry when Claude was blocked (CAPTCHA, login wall) or the key is missing.
        const retry = job.attempts < 2 && !/Claude stopped|OPENROUTER_API_KEY|did not find any steps|Saved login/.test(err.message);
        await jobs.updateOne({ _id: job._id }, { $set: { status: retry ? 'queued' : 'failed', error: err.message.slice(0, 2000) } });
        log(`failed (${retry ? 'will retry' : 'giving up'}): ${err.message.split('\n')[0]}`);
      }
    }
    demo?.server.close();
  })();

  return { stop: async () => { state.stopping = true; await loop; } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = await startWorker();
  process.on('SIGTERM', async () => {
    console.log('SIGTERM: finishing current job, then exiting');
    await worker.stop();
    await closeDb();
    process.exit(0);
  });
}
