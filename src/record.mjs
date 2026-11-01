// Replays a storyboard in headless Chromium and records it with Playwright's screencast API.
// No LLM is involved here: the storyboard is a fixed list of steps, so the replay is repeatable.
import { chromium } from 'playwright';
// Keep the browser alive when the server is asked to stop, so the worker decides what happens to the job.
const LAUNCH = { handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false };
import fs from 'node:fs/promises';
import path from 'node:path';
import { locate, perform, performPageStep } from './locate.mjs';
import { takeOver } from './repair.mjs';
import { repairModel, newUsage } from './ai.mjs';
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
export async function record({ storyboard, baseUrl, outDir, brand = {}, voiceMs = [], storageState, slow = false, log = console.log }) {
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
  await page.goto(new URL(storyboard.startUrl, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
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
    const loc = locate(page, step.target, step.label);
    await loc.waitFor({ state: 'visible', timeout: 10_000 });
    if (step.do === 'expect') return; // proves the step reached the right screen
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const box = await loc.boundingBox();
    if (!box) throw new Error('The element has no size on screen.');
    // Glide to the control, pulse a ring around it for about a second, then use it.
    await glide(page, box.x + box.width / 2, box.y + box.height / 2);
    const ring = step.do !== 'press';
    if (ring) await page.evaluate(([x, y, w, h]) => window.__demoHighlight?.(x, y, w, h), [box.x, box.y, box.width, box.height]);
    await sleep(ring ? 1100 : 300);
    const aStart = now();
    try {
      await perform(page, loc, step, { timeout: 12_000 });
    } finally {
      if (ring) setTimeout(() => page.evaluate(() => window.__demoHighlightOff?.()).catch(() => {}), 250);
    }
    timeline.actions.push({
      scene: sceneIdx, do: step.do, zoom: !!step.zoom, start: aStart, end: now() + 900,
      box: { x: box.x, y: box.y, w: box.width, h: box.height },
    });
    await sleep(slow ? 2200 : 900);
    if (slow) await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  }

  try {
    for (const [i, scene] of storyboard.scenes.entries()) {
      sceneIdx = i;
      const start = now();
      skipped = 0;
      await sleep(CHAPTER_CARD_MS); // the branded chapter card is overlaid here during compose
      for (const [j, step] of scene.steps.entries()) {
        const f0 = now();
        try {
          await runStep(step);
          done.push(step);
          continue;
        } catch (err) {
          if (!repairOn() || step.do === 'pause') throw err;
          // Quick fix first, no AI: the page may just be slow.
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
          try {
            await runStep(step);
            cut(f0 + 300, now() - 3500, 'repair'); // keep only the successful try
            done.push(step);
            continue;
          } catch { /* hand over to the AI */ }
          const failedAt = now();
          const fix = await takeOver(page, { storyboard, scene, step, error: err, done, act: runStep, clock: now, usage: repairUsage, log });
          // Cut the failed tries and the AI's thinking; keep what it did on screen.
          cut(f0 + 300, fix.pauses[0]?.start ?? failedAt, 'repair');
          for (const p of fix.pauses) cut(p.start, p.end, 'repair');
          repairs.push({ scene: i, step: j, original: step, steps: fix.steps, why: fix.why });
          done.push(...fix.steps);
        }
      }
      const last = i === storyboard.scenes.length - 1;
      const left = sceneMinMs(scene.narration, voiceMs[i]) + (last ? 1200 : 0) - (now() - start - skipped);
      if (left > 0) await sleep(left);
      timeline.scenes.push({ chapter: scene.chapter, narration: scene.narration, start, end: now() });
    }
    await sleep(400);
  } catch (e) {
    // Keep a picture of the screen at the moment it failed (shown in the dashboard).
    e.screenshot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
    e.message = `Recording stopped at "${storyboard.scenes[timeline.scenes.length]?.chapter || 'a step'}" (${page.url()}): ${e.message}`;
    e.repairUsage = repairUsage;
    throw e;
  } finally {
    await page.screencast.stop().catch(() => {});
    await browser.close().catch(() => {});
  }
  await fs.writeFile(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
  return { videoPath, timeline, repairs, repairUsage };
}
