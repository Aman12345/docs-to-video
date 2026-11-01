// One job, start to finish: record -> compose -> store in MongoDB.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { record } from './record.mjs';
import { compose } from './compose.mjs';
import { getDb, ensureIndexes, saveVideo, closeDb } from './store.mjs';
import { startDemoApp } from './demo-server.mjs';

export async function makeVideo({ storyboard, baseUrl, jobId, log = console.log }) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `video-${storyboard.id}-`));
  try {
    let t = Date.now();
    const { videoPath, timeline } = await record({ storyboard, baseUrl, outDir: workDir });
    log(`recorded ${timeline.scenes.length} scenes in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    t = Date.now();
    const composed = await compose({ rawPath: videoPath, timeline, outDir: workDir });
    log(`composed ${composed.durationSec}s video in ${((Date.now() - t) / 1000).toFixed(1)}s (narration: ${composed.narrated ? 'yes' : 'off, captions only'})`);
    const db = await getDb();
    await ensureIndexes(db);
    const saved = await saveVideo(db, { storyboard, composed, jobId });
    log(`stored in MongoDB GridFS: ${saved.slug} v${saved.version}, ${(saved.sizeBytes / 1e6).toFixed(2)} MB`);
    if (process.env.KEEP_OUTPUT) await fs.cp(workDir, process.env.KEEP_OUTPUT, { recursive: true });
    return saved;
  } finally {
    if (!process.env.KEEP_WORKDIR) await fs.rm(workDir, { recursive: true, force: true });
  }
}

// CLI: node src/pipeline.mjs storyboards/export-invoices.json
if (import.meta.url === `file://${process.argv[1]}`) {
  const storyboard = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  let demo;
  if (!process.env.APP_URL) demo = await startDemoApp();
  try {
    await makeVideo({ storyboard, baseUrl: process.env.APP_URL || demo.url });
  } finally {
    demo?.server.close();
    await closeDb();
  }
}
