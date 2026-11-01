// Replays a storyboard in headless Chromium and records it with Playwright's screencast API.
// No LLM is involved here: the storyboard is a fixed list of steps, so the replay is repeatable.
import { chromium } from 'playwright';
// Keep the browser alive when the server is asked to stop, so the worker decides what happens to the job.
const LAUNCH = { handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false };
import fs from 'node:fs/promises';
import path from 'node:path';
import { locate, perform, performPageStep } from './locate.mjs';

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

export async function record({ storyboard, baseUrl, outDir, brand = {}, voiceMs = [], storageState }) {
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
  try {
    for (const [i, scene] of storyboard.scenes.entries()) {
      const start = now();
      let skipped = 0; // ms of this scene that will be trimmed out
      await sleep(CHAPTER_CARD_MS); // the branded chapter card is overlaid here during compose
      for (const step of scene.steps) {
        const w0 = now();
        if (await performPageStep(page, step, { waitSlack: 2 })) {
          const w1 = now();
          // Keep ~2 s of the wait at each end so viewers see it working, and trim the middle.
          if (step.do === 'wait' && w1 - w0 > 7000) { timeline.cuts.push({ start: w0 + 2500, end: w1 - 2000 }); skipped += w1 - w0 - 4500; }
          await sleep(400);
          continue;
        }
        const loc = locate(page, step.target, step.label);
        await loc.waitFor({ state: 'visible', timeout: 10_000 });
        if (step.do === 'expect') continue; // proves the step reached the right screen
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        const box = await loc.boundingBox();
        // Glide to the control, pulse a ring around it for about a second, then use it.
        await glide(page, box.x + box.width / 2, box.y + box.height / 2);
        const ring = step.do !== 'press';
        if (ring) await page.evaluate(([x, y, w, h]) => window.__demoHighlight?.(x, y, w, h), [box.x, box.y, box.width, box.height]);
        await sleep(ring ? 1100 : 300);
        const aStart = now();
        await perform(page, loc, step);
        if (ring) setTimeout(() => page.evaluate(() => window.__demoHighlightOff?.()).catch(() => {}), 250);
        timeline.actions.push({
          scene: i, do: step.do, zoom: !!step.zoom, start: aStart, end: now() + 900,
          box: { x: box.x, y: box.y, w: box.width, h: box.height },
        });
        await sleep(900);
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
    throw e;
  } finally {
    await page.screencast.stop().catch(() => {});
    await browser.close().catch(() => {});
  }
  await fs.writeFile(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
  return { videoPath, timeline };
}
