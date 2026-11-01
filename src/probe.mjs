// Dry run: performs a storyboard's steps without recording, to check every step works.
// Usage: node src/probe.mjs storyboards/my-video.json   (uses APP_URL or the bundled sample app)
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { startDemoApp } from './demo-server.mjs';
import { locate, perform, performPageStep } from './locate.mjs';

export async function probe(storyboard, baseUrl) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const results = [];
  try {
    await page.goto(new URL(storyboard.startUrl, baseUrl).toString());
    for (const [i, scene] of storyboard.scenes.entries()) {
      for (const step of scene.steps) {
        const label = `Scene ${i + 1} "${scene.chapter}": ${step.do} ${JSON.stringify(step.target || step.ms)}`;
        try {
          if (step.do === 'pause') continue;
          if (!(await performPageStep(page, step))) {
            const loc = locate(page, step.target, step.label);
            await loc.waitFor({ state: 'visible', timeout: 10_000 });
            if (step.do !== 'expect') await perform(page, loc, step);
          }
          results.push({ ok: true, label });
        } catch (e) {
          results.push({ ok: false, label, error: e.message.split('\n')[0] });
          return results;
        }
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sb = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const demo = process.env.APP_URL ? null : await startDemoApp(4174);
  const res = await probe(sb, process.env.APP_URL || demo.url);
  for (const r of res) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.label}${r.error ? `\n     ${r.error}` : ''}`);
  demo?.server.close();
  process.exit(res.every((r) => r.ok) ? 0 : 1);
}
