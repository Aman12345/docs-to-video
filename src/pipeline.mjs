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
import { isCheck } from './check.mjs';
import { get } from './settings.mjs';
import { getDb, ensureIndexes, saveVideo, closeDb, downloadFile } from './store.mjs';
import { reviewVideo, rewriteNarration, compareSteps, FIXES } from './review.mjs';
import { newUsage, reviewModel } from './ai.mjs';
import { SCRIPT_RULES, authorStoryboard } from './author.mjs';
import { startDemoApp } from './demo-server.mjs';

const secs = (t) => ((Date.now() - t) / 1000).toFixed(1);

// Puts the AI's fixes into the steps, so the next re-record works without the AI.
function applyRepairs(storyboard, repairs) {
  if (!repairs?.length) return storyboard;
  const sb = structuredClone(storyboard);
  for (const r of [...repairs].sort((a, b) => b.scene - a.scene || b.step - a.step)) sb.scenes[r.scene].steps.splice(r.step, 1, ...r.steps);
  return sb;
}

// rerecord: this is a re-record of an existing video (it may be approved automatically if nothing changed).
export async function makeVideo({ storyboard, baseUrl, jobId, storageState, log = console.log, rerecord = false }) {
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
    const sceneVoiceMs = () => (voiced ? clips.slice(1, -1).map((v) => v.ms) : []);
    if (voiced) log(`voiceover (${clips.voice?.label || 'test tone'}): ${clips.length} clips (intro, ${clips.length - 2} steps, outro) in ${secs(t)}s`);
    timings.voiceSec = +secs(t);
    let voiceChars = voiced ? texts.reduce((n, x) => n + x.length, 0) : 0;
    let aiUsd = 0;
    const aiFixes = [];
    const recordIt = async (slow = false, checkNote) => {
      const t1 = Date.now();
      let r;
      try {
        // Videos without a "Check your work" ending get one added by the AI (then saved, so it's done once).
        const addCheck = !storyboard.scenes.some(isCheck) && get('checkStep') !== 'off';
        const speak = voiced ? async (text) => {
          const dir = await fs.mkdtemp(path.join(workDir, 'check-'));
          return (await synthesizeVoice([text], dir, log, clips.voice || wanted))[0] || null;
        } : null;
        r = await record({ storyboard, baseUrl, outDir: workDir, brand, voiceMs: sceneVoiceMs(), storageState, slow, log, addCheck, speak, checkNote });
      } catch (e) {
        e.aiUsd = aiUsd + (e.repairUsage?.costUsd || 0);
        throw e;
      }
      aiUsd += r.repairUsage.costUsd;
      if (r.setupSteps) { storyboard = { ...storyboard, setup: r.setupSteps }; aiFixes.push('The AI fixed a step that prepares the test data; saved for next time.'); }
      if (r.repairs.length) {
        storyboard = applyRepairs(storyboard, r.repairs);
        for (const x of r.repairs) aiFixes.push(`The AI fixed a step in "${storyboard.scenes[x.scene].chapter}": ${x.why} Check that the narration still matches.`);
        log(`AI fixed ${r.repairs.length} step(s) for $${r.repairUsage.costUsd.toFixed(3)}; saved into the video's steps`);
      }
      if (r.check) {
        const { scene, clip } = r.check;
        storyboard = { ...storyboard, scenes: [...storyboard.scenes, scene] };
        texts.splice(texts.length - 1, 0, scene.narration);
        if (voiced && clip) { clips = Object.assign([...clips.slice(0, -1), clip, clips.at(-1)], { voice: clips.voice }); voiceChars += scene.narration.length; }
        aiFixes.push(`The AI added a "${scene.chapter}" ending that shows the result: "${scene.narration}" Check it shows the right thing.`);
        log(`added a "${scene.chapter}" ending; saved into the video's steps`);
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
    // The AI editor (Opus by default) reviews the finished video and decides: approve, fix, or ask a person.
    // Fixes are applied and the video is reviewed again, at most twice:
    //  narration      -> rewrite those lines, new voice, re-edit (no re-record)
    //  rerecord(-slow)-> record again (with longer waits if a screen wasn't ready)
    //  ending         -> the AI picks the result to show again, told what was wrong
    //  replan         -> plan the steps again from the request plus the editor's change (new videos only;
    //                    for a re-record the editor's suggestion goes to a person instead)
    const reviewFixes = [];
    let rv = null;
    if (get('aiReview') !== 'off' && process.env.OPENROUTER_API_KEY) {
      const usage = newUsage(reviewModel());
      try {
        for (let round = 0; ; round++) {
          rv = await reviewVideo({ storyboard, stepFrames: composed.stepFrames, outDir: workDir, usage, log });
          if (rv.verdict !== 'fix' || round >= 2) break;
          const fx = rv.findings.filter((f) => f.fix);
          const replan = fx.filter((f) => f.fix === 'replan');
          if (replan.length) {
            const ask = replan.map((f) => f.request || f.note).join(' ');
            if (rerecord) { // an approved video's steps don't change without a person
              rv = { ...rv, verdict: 'ask', question: `The AI editor suggests changing the steps: ${ask} Should it plan the video again with this change?` };
              break;
            }
            log(`AI editor round ${round + 1}: planning the steps again: ${ask}`);
            const base = storyboard.prompt || storyboard.title;
            const prevSteps = storyboard.scenes.map((sc, i) => `${i + 1}. ${sc.chapter}: ${sc.narration || ''}`).join('\n');
            const plan = await authorStoryboard({ prompt: `${base}\n\nThis is a new version of a video. The editor who reviewed the previous version asked for: "${ask}"\nThe previous version had these steps:\n${prevSteps}\nKeep what worked and make the editor's change.`,
              startUrl: storyboard.startUrl, baseUrl, storageState, log });
            aiUsd += plan.usage.costUsd;
            storyboard = { ...plan.storyboard, id: storyboard.id, prompt: base, ...(storyboard.login ? { login: storyboard.login } : {}), ...(storyboard.voice ? { voice: storyboard.voice } : {}) };
            texts.splice(0, texts.length, intro, ...storyboard.scenes.map((sc) => sc.narration || ''), outro);
            if (voiced) {
              const again = await synthesizeVoice(texts, await fs.mkdtemp(path.join(workDir, 'voice-')), log, clips.voice || wanted);
              if (again.length === texts.length) { clips = Object.assign(again, { voice: again.voice || clips.voice }); voiceChars += texts.reduce((n, x) => n + x.length, 0); }
            }
            take = await recordIt();
            composed = await editIt(take, clips);
            reviewFixes.push(`The AI editor planned the steps again: ${ask}`);
            continue;
          }
          log(`AI editor round ${round + 1}: ${fx.map((f) => `step ${f.step}: ${FIXES[f.fix]}`).join('; ')}`);
          let reRecord = false, slow = false, checkNote;
          const narr = fx.filter((f) => f.fix === 'narration');
          if (narr.length) {
            const r = await rewriteNarration({ storyboard, findings: narr, usage, scriptRules: SCRIPT_RULES });
            if (r.changed.length) {
              storyboard = r.storyboard;
              for (const i of r.changed) if (take.timeline.scenes[i]) take.timeline.scenes[i].narration = storyboard.scenes[i].narration;
              reviewFixes.push(`The AI editor rewrote the narration of step${r.changed.length > 1 ? 's' : ''} ${r.changed.map((i) => i + 1).join(', ')}: ${narr.map((f) => f.request || f.note).join(' ')}`);
            }
          }
          if (fx.some((f) => f.fix === 'rerecord-slow')) { reRecord = true; slow = true; reviewFixes.push('The AI editor saw a screen that hadn\'t finished loading, so it was re-recorded with longer waits.'); }
          if (fx.some((f) => f.fix === 'rerecord')) { reRecord = true; reviewFixes.push(`The AI editor had it re-recorded: ${fx.find((f) => f.fix === 'rerecord').note}`); }
          const ending = fx.find((f) => f.fix === 'ending');
          if (ending && storyboard.scenes.some(isCheck)) {
            const idx = storyboard.scenes.findIndex(isCheck);
            storyboard = { ...storyboard, scenes: storyboard.scenes.filter((sc) => !isCheck(sc)) };
            if (voiced) clips = Object.assign([...clips.slice(0, idx + 1), ...clips.slice(idx + 2)], { voice: clips.voice });
            reRecord = true; checkNote = ending.request || ending.note;
            reviewFixes.push(`The AI editor had the ending redone: ${checkNote}`);
          }
          texts.splice(0, texts.length, intro, ...storyboard.scenes.map((sc) => sc.narration || ''), outro);
          if (voiced && narr.length) {
            const again = await synthesizeVoice(texts, await fs.mkdtemp(path.join(workDir, 'voice-')), log, clips.voice || wanted);
            if (again.length === texts.length) { clips = Object.assign(again, { voice: again.voice || clips.voice }); voiceChars += texts.reduce((n, x) => n + x.length, 0); }
          }
          if (reRecord) take = await recordIt(slow, checkNote);
          composed = await editIt(take, clips);
        }
      } catch (e) {
        log(`AI editor couldn't finish (${String(e.message).split('\n')[0].slice(0, 160)}); a person should check this video`);
        rv = null;
      }
      aiUsd += usage.costUsd;
    }
    const state = !rv ? 'skipped' : rv.verdict === 'approve' ? 'approved' : rv.verdict === 'ask' ? 'question' : 'failed';
    composed.review = { state, verdict: rv?.verdict || null, confidence: rv?.confidence ?? null, summary: rv?.summary || '', question: rv?.question || '',
      findings: rv?.findings || [], fixes: reviewFixes, model: rv?.model || reviewModel(), at: new Date() };
    composed.qa.fixes = [...aiFixes, ...fixes, ...reviewFixes];
    composed.voiceName = composed.narrated ? clips.voice?.label || null : null;
    log(`composed ${composed.durationSec}s ${brand.name}-branded video in ${secs(t)}s (audio: ${composed.narrated ? 'voiceover + captions' : 'captions only'}; trimmed ${composed.trimmedSec}s of dead time; quality: ${composed.qa.ok ? 'ok' : composed.qa.warnings.length + ' warning(s)'})`);
    if (composed.qa.warnings.length) log(`quality warnings: ${composed.qa.warnings.join(' ')}`);
    const db = await getDb();
    await ensureIndexes(db);
    // Approval. "AI" mode: the editor's confident approval makes it live; people only get its questions.
    // "Person" mode: new videos wait for a person; re-records the editor approved whose screens match the
    // live version go live automatically.
    let approve = null;
    const aiMode = get('approvalMode') !== 'person';
    if (aiMode && state === 'approved' && composed.review.confidence >= 0.7) {
      approve = { by: 'ai', reason: `Approved by the AI editor (${composed.review.model}): ${composed.review.summary || 'ready to publish.'}` };
      log(`approved by the AI editor (confidence ${composed.review.confidence.toFixed(2)})`);
    }
    const prev = rerecord ? await db.collection('videos').findOne({ slug: storyboard.id }, { projection: { live: 1, status: 1, files: 1 } }) : null;
    const liveSteps = prev?.live?.files?.steps || (prev?.status === 'approved' ? prev.files?.steps : null);
    if (approve) { /* already approved by the editor */ } else if (rerecord && state === 'approved' && get('autoApprove') !== 'off' && liveSteps?.length) {
      const dir = await fs.mkdtemp(path.join(workDir, 'live-'));
      const livePaths = [];
      for (const [i, id] of liveSteps.entries()) livePaths.push(await downloadFile(db, id, path.join(dir, `live-${i}.jpg`)).catch(() => null));
      const cmp = livePaths.every(Boolean) ? await compareSteps(livePaths, composed.stepFrames || []) : { changed: true, reason: 'the live screenshots could not be read' };
      const limit = Number(process.env.AUTO_APPROVE_MAX_CHANGE_PCT || 0.6); // % of a step's screen allowed to differ
      if (!cmp.changed && cmp.max <= limit) {
        approve = { by: 'auto', reason: `The AI review passed and every step looks the same as the live version (at most ${cmp.max.toFixed(1)}% of a screen changed).` };
        log(`approved automatically: screens match the live version (at most ${cmp.max.toFixed(1)}% changed)`);
      } else {
        const worst = cmp.pct?.length ? cmp.pct.indexOf(cmp.max) + 1 : 0;
        composed.review.changed = cmp.reason || `step ${worst}'s screen changed (${cmp.max.toFixed(1)}% different from the live version)`;
        log(`waiting for a person: ${composed.review.changed}`);
      }
    } else log(`waiting for a person: ${state === 'question' ? `the AI editor asks: ${composed.review.question}` : state === 'failed' ? 'the AI editor couldn\'t fix everything in 2 rounds' : state === 'skipped' ? 'the AI editor didn\'t run' : aiMode ? `the editor wasn't confident enough (${composed.review.confidence})` : !rerecord ? 'new video (a person approves new videos)' : get('autoApprove') === 'off' ? 'auto-approval is off' : 'nothing approved yet to compare with'}`);
    const saved = await saveVideo(db, { storyboard, composed, jobId, approve });
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
