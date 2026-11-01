// The branded graphics, rendered as PNGs with headless Chrome (HTML + CSS) in the chosen Miter style:
//   intro    — purple, "How to … in Miter", description, and an "In this video" card listing the steps
//   closing  — white, "You're all set", a recap line and "check your work" chips
//   chips    — small "Step 1 of 4 · Open Data Studio" pill, top-right while a step plays
//   captions — purple caption pills, bottom-centre, one per caption line (rendered on demand)
//   logo     — small Miter logo, bottom-right while the app is on screen
// Font: Plus Jakarta Sans (bundled from npm, so it renders the same everywhere).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { displayTitle, recapLine } from './narrative.mjs';

const LAUNCH = { handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false };
const require = createRequire(import.meta.url);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let fontCss;
function fonts() {
  if (fontCss) return fontCss;
  const dir = path.dirname(require.resolve('@fontsource/plus-jakarta-sans/package.json'));
  fontCss = [500, 600, 700, 800].map((w) => {
    const data = fs.readFileSync(path.join(dir, 'files', `plus-jakarta-sans-latin-${w}-normal.woff2`)).toString('base64');
    return `@font-face{font-family:"Plus Jakarta Sans";font-weight:${w};font-style:normal;src:url(data:font/woff2;base64,${data}) format("woff2")}`;
  }).join('\n');
  return fontCss;
}

const page = (body, { bg = 'transparent' } = {}) => `<!doctype html><html><head><meta charset="utf-8"><style>
${fonts()}
*{box-sizing:border-box;margin:0}
html,body{background:${bg}}
body{font-family:"Plus Jakarta Sans",sans-serif;-webkit-font-smoothing:antialiased}
</style></head><body>${body}</body></html>`;

// Logo in the brand colour of the background: white on purple, dark on white.
const logo = (brand, h, dark) => (brand.logoDark || brand.logo)
  ? `<img src="${dark ? brand.logoDark || brand.logo : brand.logo}" style="height:${h}px;width:auto;display:block" alt="">`
  : `<div style="font-weight:800;font-size:${h}px;color:${dark ? '#1A1523' : '#fff'}">${esc(brand.name)}</div>`;

function introHtml(brand, sb, minutesLabel) {
  const n = sb.scenes.length;
  const row = (sc, i) => `<div style="display:flex;align-items:center;gap:21px;padding:16px 0;${i ? 'border-top:1.5px solid #EFE7F8;' : ''}font-size:28px;font-weight:600">
    <span style="width:45px;height:45px;flex:none;border-radius:50%;background:${brand.primary};color:#fff;display:flex;align-items:center;justify-content:center;font-size:21px;font-weight:700">${i + 1}</span>${esc(sc.chapter)}</div>`;
  return page(`<div style="width:1920px;height:1080px;padding:90px 120px;background:${brand.primary};color:#fff;display:flex;flex-direction:column;justify-content:space-between">
  <div style="display:flex;align-items:center;gap:24px">${logo(brand, 45, false)}
    <span style="font-size:22px;font-weight:600;color:#EADCFB;padding-left:24px;border-left:1.5px solid rgba(255,255,255,.35)">How-to videos</span></div>
  <div style="display:flex;gap:96px;align-items:center">
    <div style="flex:1.3;display:flex;flex-direction:column;gap:30px">
      <p style="font-size:21px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#EADCFB">${esc(sb.category ? `${sb.category} · ` : '')}${n} step${n === 1 ? '' : 's'}</p>
      <h1 style="font-size:${displayTitle(sb, brand).length > 60 ? 70 : 84}px;line-height:1.08;font-weight:800;letter-spacing:-.02em">${esc(displayTitle(sb, brand))}</h1>
      ${sb.description ? `<p style="font-size:30px;line-height:1.5;color:#F3EAFE">${esc(sb.description)}</p>` : ''}
    </div>
    <div style="flex:1;background:#fff;color:#1A1523;border-radius:30px;padding:42px 48px;display:flex;flex-direction:column">
      <p style="margin:0 0 15px;font-size:20px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${brand.primary}">In this video</p>
      ${sb.scenes.slice(0, 6).map(row).join('')}
    </div>
  </div>
  <p style="font-size:22px;color:#EADCFB">${esc(minutesLabel)} · Narrated, with captions</p>
</div>`);
}

// Closing: short and clean. Logo, a check, "That's it!" and one line. No recap or checklist.
function closingHtml(brand, sb) {
  return page(`<div style="width:1920px;height:1080px;padding:90px 132px;background:#fff;color:#1A1523;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px;text-align:center">
  <div style="width:132px;height:132px;border-radius:50%;background:${brand.primary};display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 22px #F4E9FD">
    <svg width="66" height="66" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
  <h1 style="margin-top:22px;font-size:96px;line-height:1.05;font-weight:800;letter-spacing:-.02em">That's it!</h1>
  <p style="font-size:34px;line-height:1.45;color:#5F5670;max-width:1400px">${esc(recapLine(sb, brand))}</p>
  <div style="margin-top:40px">${logo(brand, 40, true)}</div>
</div>`, { bg: '#fff' });
}

const chipHtml = (brand, i, n, sc) => page(`<div id="el" style="display:inline-block;padding:16px">
  <div style="display:flex;align-items:center;gap:16px;background:rgba(255,255,255,.96);border:1.5px solid #E3D5F5;border-radius:999px;padding:10px 24px 10px 20px;box-shadow:0 10px 30px rgba(60,20,110,.14)">
    ${logo(brand, 24, true)}<span style="width:1.5px;height:26px;background:#E3D5F5"></span>
    <span style="background:${brand.primary};color:#fff;border-radius:999px;padding:7px 18px;font-size:20px;font-weight:700">Step ${i + 1} of ${n}</span>
    <span style="font-size:23px;font-weight:700;color:#1A1523;white-space:nowrap">${esc(sc.chapter)}</span>
  </div></div>`);

const captionHtml = (brand, text) => page(`<div id="el" style="display:inline-block;padding:20px 24px 28px">
  <div style="max-width:820px;background:${brand.primary};color:#fff;border-radius:24px;padding:20px 38px;font-size:29px;font-weight:600;line-height:1.4;text-align:center;text-wrap:balance;box-shadow:0 14px 36px rgba(60,20,110,.28)">${esc(text)}</div></div>`);

const logoHtml = (brand) => page(`<div id="el" style="display:inline-block;padding:4px;opacity:.85">${logo(brand, 30, true)}</div>`);

// Renders an element-sized PNG (transparent around rounded corners) and returns {file, w, h}.
async function shotEl(pg, html, file) {
  await pg.setContent(html, { waitUntil: 'load' });
  await pg.evaluate(() => document.fonts.ready);
  const el = pg.locator('#el');
  const box = await el.boundingBox();
  await el.screenshot({ path: file, omitBackground: true });
  return { file, w: Math.round(box.width), h: Math.round(box.height) };
}

export async function renderCards({ storyboard, brand, outDir, estimatedSec = 60 }) {
  const minutes = Math.max(1, Math.round(estimatedSec / 60));
  const minutesLabel = estimatedSec < 75 ? 'About 1 minute' : `About ${minutes} minutes`;
  const browser = await chromium.launch(LAUNCH);
  const pg = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  try {
    const full = async (html, file) => {
      await pg.setContent(html, { waitUntil: 'load' });
      await pg.evaluate(() => document.fonts.ready);
      const p = path.join(outDir, file);
      await pg.screenshot({ path: p });
      return p;
    };
    const n = storyboard.scenes.length;
    const cards = {
      intro: await full(introHtml(brand, storyboard, minutesLabel), 'card-intro.png'),
      outro: await full(closingHtml(brand, storyboard), 'card-outro.png'),
      logo: await shotEl(pg, logoHtml(brand), path.join(outDir, 'card-logo.png')),
      chips: [],
    };
    for (const [i, s] of storyboard.scenes.entries()) cards.chips.push(await shotEl(pg, chipHtml(brand, i, n, s), path.join(outDir, `card-chip-${i}.png`)));
    return cards;
  } finally {
    await browser.close();
  }
}

// Caption pills, one PNG per caption line.
export async function renderCaptions({ texts, brand, outDir }) {
  const browser = await chromium.launch(LAUNCH);
  const pg = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  try {
    const out = [];
    for (const [i, t] of texts.entries()) out.push(await shotEl(pg, captionHtml(brand, t), path.join(outDir, `caption-${i}.png`)));
    return out;
  } finally {
    await browser.close();
  }
}
