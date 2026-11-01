// Demo mode: one Render web service runs everything — the web page and API, the worker,
// and (unless APP_URL is set) the sample app being filmed. For production, split the
// API and the worker into two services (see render.yaml).
import { startApi } from './api.mjs';
import { startWorker } from './worker.mjs';
import { closeDb } from './store.mjs';

const server = await startApi();
const worker = await startWorker();

process.on('SIGTERM', async () => {
  console.log('SIGTERM: handing the current job back to the queue, then exiting');
  server.close();
  await worker.handBack();
  await closeDb();
  process.exit(0);
});
