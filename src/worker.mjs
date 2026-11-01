// video-worker: takes queued jobs from MongoDB one at a time, records the video,
// and stores the result back in MongoDB. In production it runs as its own Render
// background worker; in the demo, src/server.mjs runs it inside the web service.
import { getDb, ensureIndexes, closeDb } from './store.mjs';
import { makeVideo } from './pipeline.mjs';
import { startDemoApp } from './demo-server.mjs';

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
      log(`started: ${job.storyboard.title}`);
      try {
        const saved = await makeVideo({ storyboard: job.storyboard, baseUrl, jobId: job._id, log });
        await jobs.updateOne({ _id: job._id }, { $set: { status: 'done', finishedAt: new Date(), result: saved } });
        log('done');
      } catch (err) {
        const retry = job.attempts < 2;
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
