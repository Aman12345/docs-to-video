// Replays a storyboard in headless Chromium and records it with Playwright's screencast API.
// No LLM is involved here: the storyboard is a fixed list of steps, so the replay is repeatable.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { locate, perform, performPageStep } from './locate.mjs';

// Screencast frames match the page's CSS size, so record at 1280x720; compose upscales to 1080p.
const VIEWPORT = { width: 1280, height: 720 };
export const CHAPTER_CARD_MS = 1600; // time at the start of each scene reserved for its title card

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Eased glide over ~0.7 s; the cursor's CSS transition smooths the gaps between moves.
let pos = { x: 640, y: 360 };
async function glide(page, x, y, steps = 32) {
  const from = { ...pos };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await sleep(14);
  }
  pos = { x, y };
}

// How long a scene must last: long enough to read the caption, and to finish its voiceover.
const sceneMinMs = (text, voiceMs = 0) => Math.max(3500, (text.split(/\s+/).length / 2.6) * 1000 + 1200, voiceMs ? CHAPTER_CARD_MS + voiceMs + 700 : 0);

export async function record({ storyboard, baseUrl, outDir, brand = {}, voiceMs = [], storageState }) {
  await fs.mkdir(outDir, { recursive: true });
  const videoPath = path.join(outDir, 'raw.webm');
  const browser = await chromium.launch(); // headless; Render has no display
  const context = await browser.newContext({ viewport: VIEWPORT, ...(storageState ? { storageState } : {}) });
  await context.addInitScript({ content: `window.__demoBrand = ${JSON.stringify({ primary: brand.primary })};` });
  await context.addInitScript({ path: new URL('./cursor.js', import.meta.url).pathname });
  const page = await context.newPage();
  await page.goto(new URL(storyboard.startUrl, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  pos = { x: 640, y: 360 };
  await page.mouse.move(pos.x, pos.y);

  await page.screencast.start({ path: videoPath, size: VIEWPORT, quality: 92 });
  const t0 = Date.now();
  const now = () => Date.now() - t0;

  const timeline = { width: VIEWPORT.width, height: VIEWPORT.height, scenes: [], actions: [] };
  try {
    for (const [i, scene] of storyboard.scenes.entries()) {
      const start = now();
      await sleep(CHAPTER_CARD_MS); // the branded chapter card is overlaid here during compose
      for (const step of scene.steps) {
        if (await performPageStep(page, step)) { await sleep(400); continue; }
        const loc = locate(page, step.target, step.label);
        await loc.waitFor({ state: 'visible', timeout: 10_000 });
        if (step.do === 'expect') continue; // proves the step reached the right screen
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        const box = await loc.boundingBox();
        // Glide to the control, ring it, pause a beat, then use it (ripple + bounce happen on click).
        await glide(page, box.x + box.width / 2, box.y + box.height / 2);
        if (step.do !== 'press') await page.evaluate(([x, y, w, h]) => window.__demoHighlight?.(x, y, w, h), [box.x, box.y, box.width, box.height]);
        await sleep(450);
        const aStart = now();
        await perform(page, loc, step);
        timeline.actions.push({
          scene: i, do: step.do, zoom: !!step.zoom, start: aStart, end: now() + 900,
          box: { x: box.x, y: box.y, w: box.width, h: box.height },
        });
        await sleep(900);
      }
      const last = i === storyboard.scenes.length - 1;
      const left = sceneMinMs(scene.narration, voiceMs[i]) + (last ? 1200 : 0) - (now() - start);
      if (left > 0) await sleep(left);
      timeline.scenes.push({ chapter: scene.chapter, narration: scene.narration, start, end: now() });
    }
    await sleep(400);
  } finally {
    await page.screencast.stop();
    await browser.close();
  }
  await fs.writeFile(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
  return { videoPath, timeline };
}
