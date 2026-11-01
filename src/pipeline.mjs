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
    const intro = introText(storyboard, brand), outro = outroText(storyboard, brand);
    const texts = [intro, ...storyboard.scenes.map((s) => s.narration || ''), outro];
    let clips = await synthesizeVoice(texts, workDir, log);
    const voiced = clips.length === texts.length;
    const voice = voiced ? clips.slice(1, -1) : [];
    if (voiced) log(`voiceover: ${clips.length} clips (intro, ${voice.length} steps, outro) in ${secs(t)}s`);
    timings.voiceSec = +secs(t);
    let voiceChars = voiced ? texts.reduce((n, x) => n + x.length, 0) : 0;
    const recordIt = async (slow = false) => {
      const t1 = Date.now();
      const r = await record({ storyboard, baseUrl, outDir: workDir, brand, voiceMs: voice.map((v) => v.ms), storageState, slow });
      log(`recorded ${r.timeline.scenes.length} scenes in ${secs(t1)}s${slow ? ' (slow re-record)' : ''}`);
      timings.recordSec = (timings.recordSec || 0) + +secs(t1);
      return r;
    };
    const editIt = async ({ videoPath, timeline }, c = clips) => {
      const t1 = Date.now();
      const cutMs = (timeline.cuts || []).reduce((n, x) => n + x.end - x.start, 0);
      const cards = await renderCards({ storyboard, brand, outDir: workDir, estimatedSec: (timeline.scenes.at(-1).end - cutMs) / 1000 + 12 });
      const out = await compose({ rawPath: videoPath, timeline, outDir: workDir, brand, cards, voice: voiced ? c.slice(1, -1) : [], storyboard,
        introVoice: voiced ? c[0] : null, outroVoice: voiced ? c.at(-1) : null, introText: intro, outroText: outro });
      timings.composeSec = (timings.composeSec || 0) + +secs(t1);
      return out;
    };

    let take = await recordIt();
    let composed = await editIt(take);

    // Automatic fixes for quality warnings (at most once each, then a person decides):
    //  - silent or quiet voice: make the voice again and re-edit, keeping the same recording
    //  - a step ends on a blank screen: re-record once, slower, so pages have time to load
    //  - anything else (e.g. too long): flagged only
    const fixes = [];
    if (composed.qa.codes.includes('silent-voice') && voiced) {
      log('quality: voice was silent, making it again');
      const again = await synthesizeVoice(texts, workDir, log);
      if (again.length === texts.length) {
        clips = again;
        voiceChars *= 2; // paid for twice
        composed = await editIt(take, clips);
        fixes.push(composed.qa.codes.includes('silent-voice') ? 'Remade the voice once; it is still quiet, so check it.' : 'The voice came out silent, so it was remade automatically.');
      }
    }
    if (composed.qa.codes.includes('blank-step')) {
      log('quality: a step ended on a blank screen, re-recording once with longer waits');
      take = await recordIt(true);
      composed = await editIt(take, clips);
      fixes.push(composed.qa.codes.includes('blank-step') ? 'Re-recorded once with longer waits; a step still ends on a blank screen, so check it.' : 'A step ended on a blank screen, so it was re-recorded automatically with longer waits.');
    }
    composed.qa.fixes = fixes;
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
