// Replays a storyboard in headless Chromium and records it with Playwright's screencast API.
// No LLM is involved here: the storyboard is a fixed list of steps, so the replay is repeatable.
import { chromium } from 'playwright';
// Keep the browser alive when the server is asked to stop, so the worker decides what happens to the job.
const LAUNCH = { handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false };
import fs from 'node:fs/promises';
import path from 'node:path';
import { locate, perform, performPageStep } from './locate.mjs';
import { takeOver } from './repair.mjs';
import { planCheck, isCheck, CHECK_CHAPTER } from './check.mjs';
import { repairModel, newUsage, describe } from './ai.mjs';
import { get } from './settings.mjs';

// AI takeover is on when an OpenRouter key is set; REPAIR=off turns it off.
const repairOn = () => !!process.env.OPENROUTER_API_KEY && !/^off$/i.test(get('repair') || '');

// Sharp 1080p: the browser window is 1920x1080 and the app is zoomed to 150%, so it lays out like a
// 1280x720 screen but is drawn with 1.5x the pixels (screencast frames are captured at window size,
// so this is native resolution, not an enlarged picture). RECORD_ZOOM=1 turns it off.
const VIEWPORT = { width: 1920, height: 1080 };
const ZOOM = Number(process.env.RECORD_ZOOM || 1.5);
export const CHAPTER_CARD_MS = 700; // short beat at the start of each step while its step chip appears

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const REDACT_DEFAULTS = ['\\b\\d{3}-\\d{2}-\\d{4}\\b', '\\b\\d{2}-\\d{7}\\b', '\\b\\d{9,17}\\b'];

// Eased glide over ~0.7 s; the cursor's CSS transition smooths the gaps between moves.
let pos = { x: 960, y: 540 };
async function glide(page, x, y, steps = 36) {
  const from = { ...pos };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await sleep(12);
  }
  pos = { x, y };
}

// How long a scene must last: long enough to read the caption, and to finish its voiceover.
const sceneMinMs = (text, voiceMs = 0) => Math.max(3500, (text.split(/\s+/).length / 2.6) * 1000 + 1200, voiceMs ? CHAPTER_CARD_MS + voiceMs + 700 : 0);

// slow: used for an automatic re-record after a blank-screen warning; gives pages more time to load.
// addCheck: the steps have no "Check your work" ending yet, so the AI adds one at the end (speak(text) makes its voice).
export async function record({ storyboard, baseUrl, outDir, brand = {}, voiceMs = [], storageState, slow = false, log = console.log, addCheck = false, speak, checkNote }) {
  await fs.mkdir(outDir, { recursive: true });
  const videoPath = path.join(outDir, 'raw.webm');
  const browser = await chromium.launch(LAUNCH); // headless; Render has no display
  const context = await browser.newContext({ viewport: VIEWPORT, ...(storageState ? { storageState } : {}) });
  await context.addInitScript({ content: `window.__demoBrand = ${JSON.stringify({ primary: brand.primary })}; window.__demoZoom = ${ZOOM};
    (() => { const z = () => { if (document.documentElement) document.documentElement.style.setProperty('zoom', '${ZOOM}', 'important'); };
      z(); document.addEventListener('DOMContentLoaded', z); })();` });
  await context.addInitScript({ path: new URL('./cursor.js', import.meta.url).pathname });
  // Blur sensitive numbers (SSNs, EINs, account numbers) before they are recorded. REDACT=off disables;
  // REDACT_PATTERNS='["regex", ...]' replaces the defaults.
  const patterns = process.env.REDACT_PATTERNS ? JSON.parse(process.env.REDACT_PATTERNS) : REDACT_DEFAULTS;
  await context.addInitScript({ content: `window.__demoRedact = ${JSON.stringify({ off: /^off$/i.test(process.env.REDACT || ''), patterns })};` });
  await context.addInitScript({ path: new URL('./redact.js', import.meta.url).pathname });
  const page = await context.newPage();
  const startAt = new URL(storyboard.startUrl, baseUrl).toString();
  await page.goto(startAt, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  // Off-camera steps: setup (prepare the test data the video needs) runs before filming starts, cleanup
  // (remove what the video created) after it stops. A broken setup step is fixed by the AI like any other.
  const offUsage = newUsage(repairModel());
  const plainStep = async (st) => {
    if (await performPageStep(page, st)) return;
    if (!st.target) throw new Error(`The "${st.do}" step has no target.`);
    const loc = locate(page, st.target);
    await loc.waitFor({ state: 'visible', timeout: 15_000 });
    await perform(page, loc, st, { timeout: 15_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(700);
  };
  let setupSteps = null; // set when the AI changed a setup step, so the fix is saved
  if (storyboard.setup?.length) try {
    log(`preparing test data off-camera: ${storyboard.setupWhy || `${storyboard.setup.length} steps`}`);
    const fixed = [];
    for (const st of storyboard.setup) {
      try { await plainStep(st); fixed.push(st); } catch (err) {
        if (!repairOn()) throw Object.assign(err, { message: `Preparing the test data failed: ${err.message}` });
        log(`  setup step didn't work (${String(err.message).split('\n')[0].slice(0, 120)}); the AI is taking over`);
        const fix = await takeOver(page, { storyboard, scene: { chapter: 'Preparing test data (not recorded)', narration: storyboard.setupWhy || '' }, step: st, error: err, done: fixed, act: plainStep, clock: () => 0, usage: offUsage, log });
        fixed.push(...fix.steps);
        setupSteps = fixed;
      }
    }
    await page.goto(startAt, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
  } catch (e) {
    e.screenshot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
    e.repairUsage = offUsage;
    await browser.close().catch(() => {});
    throw e;
  }
  pos = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  await page.mouse.move(pos.x, pos.y);

  await page.screencast.start({ path: videoPath, size: VIEWPORT, quality: 95 });
  const t0 = Date.now();
  const now = () => Date.now() - t0;

  // cuts: long waits (e.g. Miter AI building a report) that compose trims out of the final video.
  const timeline = { width: VIEWPORT.width, height: VIEWPORT.height, scenes: [], actions: [], cuts: [] };
  // repairs: steps the AI fixed during this recording; saved into the video's steps afterwards.
  const repairs = [];
  const repairUsage = newUsage(repairModel());
  const done = [];
  let sceneIdx = 0, skipped = 0; // skipped: ms of the current scene that will be trimmed out
  const cut = (start, end, kind) => { if (end - start >= 500) { timeline.cuts.push({ start, end, ...(kind ? { kind } : {}) }); skipped += end - start; } };

  // One step, performed on screen. Throws if it doesn't work.
  async function runStep(step) {
    const w0 = now();
    if (await performPageStep(page, step, { waitSlack: 2 })) {
      const w1 = now();
      // Keep ~2 s of the wait at each end so viewers see it working, and trim the middle.
      if (step.do === 'wait' && w1 - w0 > 7000) cut(w0 + 2500, w1 - 2000, 'wait');
      await sleep(400);
      return;
    }
    if (!step.target) throw new Error(`The "${step.do}" step has no target.`);
    await page.evaluate(() => window.__demoHighlightOff?.(true)).catch(() => {}); // no leftover ring from a previous step
    const loc = locate(page, step.target, step.label);
    await loc.waitFor({ state: 'visible', timeout: 10_000 });
    if (step.do === 'expect') return; // proves the step reached the right screen
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const box = await loc.boundingBox();
    if (!box) throw new Error('The element has no size on screen.');
    if (step.do === 'show') {
      // "Check your work": point at the result, ring it and hold, without clicking. Big results (a whole
      // report) aren't zoomed; small ones (a new row, a confirmation) get a gentle zoom.
      const big = box.width * box.height > 0.35 * VIEWPORT.width * VIEWPORT.height;
      // Rest the cursor just below the result's right edge (or inside its top-right corner if there's no
      // room), so it points at the result without covering any of it.
      const below = box.y + box.height + 40 < VIEWPORT.height;
      const cx = Math.min(box.x + box.width - 30, VIEWPORT.width - 30);
      const cy = below ? box.y + box.height + 16 : Math.max(box.y + 10, 10);
      await glide(page, cx, cy);
      await page.evaluate(([x, y, w, h]) => window.__demoHighlight?.(x, y, w, h, 3200), [box.x, box.y, box.width, box.height]);
      const aStart = now();
      await sleep(2600);
      page.evaluate(() => window.__demoHighlightOff?.()).catch(() => {});
      timeline.actions.push({ scene: sceneIdx, do: 'show', zoom: !big, start: aStart, end: now(), box: { x: box.x, y: box.y, w: box.width, h: box.height } });
      return;
    }
    // Glide to the control, pulse a ring around it for about a second, then use it.
    await glide(page, box.x + box.width / 2, box.y + box.height / 2);
    const ring = step.do !== 'press';
    if (ring) await page.evaluate(([x, y, w, h]) => window.__demoHighlight?.(x, y, w, h), [box.x, box.y, box.width, box.height]);
    await sleep(ring ? 1100 : 300);
    const aStart = now();
    // The ring fades as the click lands, not when the whole action ends (typing can take several seconds).
    const off = ring ? setTimeout(() => page.evaluate(() => window.__demoHighlightOff?.()).catch(() => {}), 300) : null;
    try {
      await perform(page, loc, step, { timeout: 12_000 });
    } finally {
      if (ring) { clearTimeout(off); page.evaluate(() => window.__demoHighlightOff?.()).catch(() => {}); }
    }
    timeline.actions.push({
      scene: sceneIdx, do: step.do, zoom: !!step.zoom, start: aStart, end: now() + 900,
      box: { x: box.x, y: box.y, w: box.width, h: box.height },
    });
    await sleep(slow ? 2200 : 900);
    if (slow) await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  }

  const n = storyboard.scenes.filter((s) => !isCheck(s)).length;
  let check = null;
  async function runScene(i, scene, sceneVoiceMs, last) {
      sceneIdx = i;
      log(isCheck(scene) ? `${scene.chapter} (showing the result)` : `step ${i + 1} of ${n}: ${scene.chapter}`);
      const start = now();
      skipped = 0;
      await sleep(CHAPTER_CARD_MS); // the branded chapter card is overlaid here during compose
      for (const [j, step] of scene.steps.entries()) {
        const f0 = now();
        if (step.do !== 'pause') log(`  ${describe(step)}`);
        try {
          await runStep(step);
          done.push(step);
          continue;
        } catch (err) {
          // Optional steps (e.g. closing a panel before showing the result) may no longer be needed.
          if (step.optional) { log(`  not needed this time (${String(err.message).split('\n')[0].slice(0, 120)})`); cut(f0 + 300, now() - 300, 'repair'); continue; }
          if (!repairOn() || step.do === 'pause') throw err;
          log(`  that step didn't work (${String(err.message).split('\n')[0].slice(0, 160)}); waiting for the page and trying again`);
          // Quick fix first, no AI: the page may just be slow.
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
          try {
            await runStep(step);
            cut(f0 + 300, now() - 3500, 'repair'); // keep only the successful try
            done.push(step);
            continue;
          } catch { /* hand over to the AI */ }
          log(`  still not working: the AI (${repairModel()}) is taking over`);
          const failedAt = now();
          const fix = await takeOver(page, { storyboard, scene, step, error: err, done, act: runStep, clock: now, usage: repairUsage, log });
          // Cut the failed tries and the AI's thinking; keep what it did on screen.
          cut(f0 + 300, fix.pauses[0]?.start ?? failedAt, 'repair');
          for (const p of fix.pauses) cut(p.start, p.end, 'repair');
          repairs.push({ scene: i, step: j, original: step, steps: fix.steps, why: fix.why });
          done.push(...fix.steps);
        }
      }
      const left = sceneMinMs(scene.narration, sceneVoiceMs) + (last ? 1200 : 0) - (now() - start - skipped);
      if (left > 0) await sleep(left);
      timeline.scenes.push({ chapter: scene.chapter, narration: scene.narration, start, end: now(), ...(isCheck(scene) ? { check: true } : {}) });
  }

  try {
    const total = storyboard.scenes.length;
    for (const [i, scene] of storyboard.scenes.entries()) await runScene(i, scene, voiceMs[i], i === total - 1 && !addCheck);
    // No "Check your work" ending saved yet: the AI picks the result to show and writes its line.
    // Its thinking and the voice it makes are cut, so the video goes straight into the new scene.
    if (addCheck && repairOn()) {
      const p0 = now();
      try {
        log('Check your work: the AI is finding the result to show');
        const plan = await planCheck(page, { storyboard, usage: repairUsage, log, note: checkNote,
          tryShow: async (pl) => locate(page, pl.show).waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false) });
        if (plan) {
          const clip = speak ? await speak(plan.narration).catch(() => null) : null;
          const scene = { chapter: plan.chapter || CHECK_CHAPTER, narration: plan.narration, check: true,
            steps: [...plan.reveal.map((a) => ({ ...a, optional: true })), { do: 'show', target: plan.show }, { do: 'pause', ms: 1500 }] };
          cut(p0, now(), 'repair');
          await runScene(total, scene, clip?.ms, true);
          check = { scene, clip };
        } else cut(p0, now(), 'repair');
      } catch (e) {
        cut(p0, now(), 'repair');
        log(`Check your work: skipped (${String(e.message).split('\n')[0].slice(0, 160)})`);
        if (!check) await sleep(1200);
      }
    }
    await sleep(400);
  } catch (e) {
    // Keep a picture of the screen at the moment it failed (shown in the dashboard).
    e.screenshot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
    e.message = `Recording stopped at "${storyboard.scenes[timeline.scenes.length]?.chapter || 'a step'}" (${page.url()}): ${e.message}`;
    e.repairUsage = repairUsage;
    await page.screencast.stop().catch(() => {});
    await browser.close().catch(() => {});
    throw e;
  }
  await page.screencast.stop().catch(() => {});
  // Cleanup (not recorded): best effort; anything left behind is harmless test data.
  if (storyboard.cleanup?.length) {
    log(`cleaning up test records off-camera (${storyboard.cleanup.length} steps)`);
    for (const st of storyboard.cleanup) {
      try { await plainStep(st); } catch (err) { log(`  cleanup step skipped (${String(err.message).split('\n')[0].slice(0, 120)})`); break; }
    }
  }
  await browser.close().catch(() => {});
  repairUsage.costUsd += offUsage.costUsd;
  await fs.writeFile(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
  return { videoPath, timeline, repairs, repairUsage, check, setupSteps };
}
