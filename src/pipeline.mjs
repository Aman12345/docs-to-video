// One job, start to finish: voiceover -> record -> branded cards -> compose -> store in MongoDB.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { record } from './record.mjs';
import { compose, synthesizeVoice } from './compose.mjs';
import { renderCards } from './cards.mjs';
import { getBrand } from './brand.mjs';
import { introText, outroText } from './narrative.mjs';
import { voiceById } from './voices.mjs';
import { getDb, ensureIndexes, saveVideo, closeDb } from './store.mjs';
import { startDemoApp } from './demo-server.mjs';

const secs = (t) => ((Date.now() - t) / 1000).toFixed(1);

// Puts the AI's fixes into the steps, so the next re-record works without the AI.
function applyRepairs(storyboard, repairs) {
  if (!repairs?.length) return storyboard;
  const sb = structuredClone(storyboard);
  for (const r of [...repairs].sort((a, b) => b.scene - a.scene || b.step - a.step)) sb.scenes[r.scene].steps.splice(r.step, 1, ...r.steps);
  return sb;
}

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
    const wanted = voiceById(storyboard.voice);
    let clips = await synthesizeVoice(texts, workDir, log, wanted);
    const voiced = clips.length === texts.length;
    const voice = voiced ? clips.slice(1, -1) : [];
    if (voiced) log(`voiceover (${clips.voice?.label || 'test tone'}): ${clips.length} clips (intro, ${voice.length} steps, outro) in ${secs(t)}s`);
    timings.voiceSec = +secs(t);
    let voiceChars = voiced ? texts.reduce((n, x) => n + x.length, 0) : 0;
    let aiUsd = 0;
    const aiFixes = [];
    const recordIt = async (slow = false) => {
      const t1 = Date.now();
      let r;
      try {
        r = await record({ storyboard, baseUrl, outDir: workDir, brand, voiceMs: voice.map((v) => v.ms), storageState, slow, log });
      } catch (e) {
        e.aiUsd = aiUsd + (e.repairUsage?.costUsd || 0);
        throw e;
      }
      aiUsd += r.repairUsage.costUsd;
      if (r.repairs.length) {
        storyboard = applyRepairs(storyboard, r.repairs);
        for (const x of r.repairs) aiFixes.push(`The AI fixed a step in "${storyboard.scenes[x.scene].chapter}": ${x.why} Check that the narration still matches.`);
        log(`AI fixed ${r.repairs.length} step(s) for $${r.repairUsage.costUsd.toFixed(3)}; saved into the video's steps`);
      }
      log(`recorded ${r.timeline.scenes.length} scenes in ${secs(t1)}s${slow ? ' (slow re-record)' : ''}`);
      timings.recordSec = (timings.recordSec || 0) + +secs(t1);
      return r;
    };
    const editIt = async ({ videoPath, timeline }, c = clips) => {
      const t1 = Date.now();
      log('editing: intro and closing cards, captions, voice, zooms, trimming dead time');
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
      const again = await synthesizeVoice(texts, workDir, log, clips.voice || wanted);
      if (again.length === texts.length) {
        clips = Object.assign(again, { voice: again.voice || clips.voice });
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
    composed.qa.fixes = [...aiFixes, ...fixes];
    composed.voiceName = composed.narrated ? clips.voice?.label || null : null;
    log(`composed ${composed.durationSec}s ${brand.name}-branded video in ${secs(t)}s (audio: ${composed.narrated ? 'voiceover + captions' : 'captions only'}; trimmed ${composed.trimmedSec}s of dead time; quality: ${composed.qa.ok ? 'ok' : composed.qa.warnings.length + ' warning(s)'})`);
    if (composed.qa.warnings.length) log(`quality warnings: ${composed.qa.warnings.join(' ')}`);
    const db = await getDb();
    await ensureIndexes(db);
    const saved = await saveVideo(db, { storyboard, composed, jobId });
    log(`stored in MongoDB GridFS: ${saved.slug} v${saved.version}, ${(saved.sizeBytes / 1e6).toFixed(2)} MB`);
    if (process.env.KEEP_OUTPUT) await fs.cp(workDir, process.env.KEEP_OUTPUT, { recursive: true });
    const used = clips.voice;
    return { ...saved, timings, aiUsd, aiFixed: aiFixes.length, voiceChars, voiceName: used?.label || null, voiceUsd: used ? voiceChars * used.usdPerMChar / 1e6 : 0 };
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
