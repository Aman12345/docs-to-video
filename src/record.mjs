// Replays a storyboard in headless Chromium and records it with Playwright's screencast API.
// No LLM is involved here: the storyboard is a fixed list of steps, so the replay is repeatable.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

// Screencast frames match the page's CSS size, so record at 1280x720; compose upscales to 1080p.
const VIEWPORT = { width: 1280, height: 720 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Finds the element, and gives it a plain-English name so the on-screen action label
// reads "Click Billing" instead of the raw locator code.
function locate(page, t, label) {
  let loc;
  if (t.role) loc = page.getByRole(t.role, { name: t.name, exact: true });
  else if (t.testId) loc = page.getByTestId(t.testId);
  else if (t.label) loc = page.getByLabel(t.label, { exact: true });
  else if (t.text) loc = page.getByText(t.text);
  else throw new Error(`Unsupported target: ${JSON.stringify(t)}`);
  return loc.describe(label || t.name || t.label || t.text || t.testId);
}

// Moves the mouse along an eased path over ~0.6 s, so the drawn cursor glides like a person's.
let pos = { x: 640, y: 360 };
async function glide(page, x, y, steps = 16) {
  const from = { ...pos };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await sleep(15);
  }
  pos = { x, y };
}

// Rough reading time for a narration line, so captions stay on screen long enough.
const sceneMinMs = (text) => Math.max(3500, (text.split(/\s+/).length / 2.6) * 1000 + 1200);

export async function record({ storyboard, baseUrl, outDir }) {
  await fs.mkdir(outDir, { recursive: true });
  const videoPath = path.join(outDir, 'raw.webm');
  const browser = await chromium.launch(); // headless; Render has no display
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript({ path: new URL('./cursor.js', import.meta.url).pathname });
  const page = await context.newPage();
  await page.goto(new URL(storyboard.startUrl, baseUrl).toString());
  pos = { x: 640, y: 360 };
  await page.mouse.move(pos.x, pos.y);

  await page.screencast.start({ path: videoPath, size: VIEWPORT });
  const t0 = Date.now();
  const now = () => Date.now() - t0;

  const timeline = { width: VIEWPORT.width, height: VIEWPORT.height, scenes: [], actions: [] };
  try {
    for (const [i, scene] of storyboard.scenes.entries()) {
      const start = now();
      await page.screencast.showChapter(`Step ${i + 1}: ${scene.chapter}`, { duration: 1500 });
      await sleep(1600);
      for (const step of scene.steps) {
        if (step.do === 'pause') { await sleep(step.ms); continue; }
        const loc = locate(page, step.target, step.label);
        await loc.waitFor({ state: 'visible', timeout: 10_000 });
        if (step.do === 'expect') continue; // proves the step reached the right screen
        const box = await loc.boundingBox();
        // Glide the mouse to the target so viewers can follow it.
        await glide(page, box.x + box.width / 2, box.y + box.height / 2);
        await sleep(300);
        const aStart = now();
        if (step.do === 'click') await loc.click();
        else if (step.do === 'fill' && step.value === '') await loc.fill('');
        else if (step.do === 'fill') { await loc.click(); await loc.pressSequentially(step.value, { delay: 90 }); }
        else if (step.do === 'select') await loc.selectOption({ label: step.value });
        else throw new Error(`Unsupported step: ${step.do}`);
        timeline.actions.push({
          scene: i, do: step.do, zoom: !!step.zoom, start: aStart, end: now() + 900,
          box: { x: box.x, y: box.y, w: box.width, h: box.height },
        });
        await sleep(900);
      }
      const last = i === storyboard.scenes.length - 1;
      const left = sceneMinMs(scene.narration) + (last ? 1800 : 0) - (now() - start);
      if (left > 0) await sleep(left);
      timeline.scenes.push({ chapter: scene.chapter, narration: scene.narration, start, end: now() });
    }
    await sleep(500);
  } finally {
    await page.screencast.stop();
    await browser.close();
  }
  await fs.writeFile(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
  return { videoPath, timeline };
}
