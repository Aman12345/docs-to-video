// One job, start to finish: voiceover -> record -> branded cards -> compose -> store in MongoDB.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { record } from './record.mjs';
import { compose, synthesizeVoice } from './compose.mjs';
import { renderCards } from './cards.mjs';
import { getBrand } from './brand.mjs';
import { introText, outroText } from './narrative.mjs';
import { getDb, ensureIndexes, saveVideo, closeDb } from './store.mjs';
import { startDemoApp } from './demo-server.mjs';

const secs = (t) => ((Date.now() - t) / 1000).toFixed(1);

export async function makeVideo({ storyboard, baseUrl, jobId, storageState, log = console.log }) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `video-${storyboard.id}-`));
  try {
    const brand = await getBrand();
    const timings = {};
    let t = Date.now();
    // Voice first, so the recorder holds each scene long enough for its sentence.
    // Spoken intro (what you'll learn + the steps), one line per scene, and a closing recap.
    const intro = introText(storyboard), outro = outroText(storyboard);
    const texts = [intro, ...storyboard.scenes.map((s) => s.narration || ''), outro];
    const clips = await synthesizeVoice(texts, workDir, log);
    const voiced = clips.length === texts.length;
    const voice = voiced ? clips.slice(1, -1) : [];
    if (voiced) log(`voiceover: ${clips.length} clips (intro, ${voice.length} steps, outro) in ${secs(t)}s`);
    timings.voiceSec = +secs(t);
    const voiceChars = voiced ? texts.reduce((n, x) => n + x.length, 0) : 0;
    t = Date.now();
    const { videoPath, timeline } = await record({ storyboard, baseUrl, outDir: workDir, brand, voiceMs: voice.map((v) => v.ms), storageState });
    log(`recorded ${timeline.scenes.length} scenes in ${secs(t)}s`);
    timings.recordSec = +secs(t);
    t = Date.now();
    const cards = await renderCards({ storyboard, brand, outDir: workDir });
    const composed = await compose({ rawPath: videoPath, timeline, outDir: workDir, brand, cards, voice, storyboard,
      introVoice: voiced ? clips[0] : null, outroVoice: voiced ? clips.at(-1) : null, introText: intro, outroText: outro });
    timings.composeSec = +secs(t);
    log(`composed ${composed.durationSec}s ${brand.name}-branded video in ${secs(t)}s (audio: ${composed.narrated ? 'voiceover + captions' : 'captions only'}; trimmed ${composed.trimmedSec}s of dead time; quality: ${composed.qa.ok ? 'ok' : composed.qa.warnings.length + ' warning(s)'})`);
    const db = await getDb();
    await ensureIndexes(db);
    const saved = await saveVideo(db, { storyboard, composed, jobId });
    log(`stored in MongoDB GridFS: ${saved.slug} v${saved.version}, ${(saved.sizeBytes / 1e6).toFixed(2)} MB`);
    if (process.env.KEEP_OUTPUT) await fs.cp(workDir, process.env.KEEP_OUTPUT, { recursive: true });
    return { ...saved, timings, voiceChars };
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
