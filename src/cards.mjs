// Renders the branded graphics as PNGs with headless Chrome (HTML + CSS, so they look polished):
// intro card, closing card, a title card per chapter, a "Step 2 of 4" label per chapter, and a
// small logo for the caption band. The composer overlays these on the recording with ffmpeg.
import { chromium } from 'playwright';
import path from 'node:path';
import { checksFor } from './narrative.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const base = (brand, body, { transparent = false } = {}) => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}html,body{width:1920px;height:1080px}
body{font-family:Inter,"Noto Sans","DejaVu Sans",sans-serif;color:#fff;-webkit-font-smoothing:antialiased;
${transparent ? 'background:transparent' : `background:radial-gradient(1200px 700px at 78% 18%, ${brand.primary}55, transparent 60%), radial-gradient(900px 600px at 10% 95%, ${brand.primary}33, transparent 60%), ${brand.dark}`}}
.wordmark{font-weight:800;letter-spacing:-.02em}
.logo{max-height:84px;max-width:420px;object-fit:contain}
</style></head><body>${body}</body></html>`;

const logoOrName = (brand, size = 64) => brand.logo
  ? `<img class="logo" style="max-height:${size + 20}px" src="${brand.logo}" alt="">`
  : `<div class="wordmark" style="font-size:${size}px">${esc(brand.name)}</div>`;

// Intro: title and description on the left, the list of steps ("In this video") on the right.
function introHtml(brand, sb) {
  const n = sb.scenes.length;
  return base(brand, `<div style="position:absolute;inset:0;padding:110px 140px;display:flex;flex-direction:column;justify-content:space-between">
    <div style="display:flex;align-items:center;gap:22px">${logoOrName(brand, 52)}<div style="font-size:26px;opacity:.75;padding-left:22px;border-left:2px solid #ffffff40">${esc(brand.tagline)}</div></div>
    <div style="display:flex;gap:90px;align-items:center">
      <div style="flex:1.25"><div style="display:inline-block;font-size:24px;font-weight:600;padding:8px 18px;border-radius:999px;background:${brand.primary};margin-bottom:28px">How-to guide &middot; ${n} step${n === 1 ? '' : 's'}</div>
        <div style="font-size:80px;font-weight:800;line-height:1.05;letter-spacing:-.025em">${esc(sb.title)}</div>
        ${sb.description ? `<div style="font-size:30px;line-height:1.4;opacity:.8;margin-top:26px">${esc(sb.description)}</div>` : ''}</div>
      <div style="flex:1;background:#ffffff10;border:1px solid #ffffff26;border-radius:28px;padding:40px 44px">
        <div style="font-size:24px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin-bottom:22px">In this video</div>
        ${sb.scenes.map((sc, i) => `<div style="display:flex;gap:20px;align-items:center;padding:13px 0;${i ? 'border-top:1px solid #ffffff1f;' : ''}font-size:32px;font-weight:600">
          <span style="flex:none;width:48px;height:48px;border-radius:50%;background:${brand.primary};display:grid;place-items:center;font-size:24px">${i + 1}</span>${esc(sc.chapter)}</div>`).join('')}
      </div></div>
    <div style="height:6px;width:220px;border-radius:6px;background:${brand.primary}"></div></div>`);
}

// Outro: "You're all set", a recap of the steps done, and optional "check your work" points.
function outroHtml(brand, sb, checks = []) {
  const tick = (c) => `<svg width="30" height="30" viewBox="0 0 24 24" style="flex:none"><circle cx="12" cy="12" r="12" fill="${c}"/><path d="M6.5 12.5l3.5 3.5 7.5-8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return base(brand, `<div style="position:absolute;inset:0;padding:110px 140px;display:flex;gap:90px;align-items:center">
    <div style="flex:1">
      <div style="width:110px;height:110px;border-radius:50%;background:${brand.primary};display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 18px ${brand.primary}33;margin-bottom:44px">
        <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
      <div style="font-size:84px;font-weight:800;letter-spacing:-.02em">You're all set</div>
      <div style="font-size:34px;opacity:.8;margin-top:14px">${esc(sb.title)}</div>
      <div style="font-size:26px;opacity:.6;margin-top:30px">${esc(brand.support)}</div>
      <div style="margin-top:50px">${logoOrName(brand, 40)}</div></div>
    <div style="flex:1;display:flex;flex-direction:column;gap:26px">
      <div style="background:#ffffff10;border:1px solid #ffffff26;border-radius:28px;padding:36px 42px">
        <div style="font-size:24px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin-bottom:16px">What you did</div>
        ${sb.scenes.map((sc) => `<div style="display:flex;gap:18px;align-items:center;padding:9px 0;font-size:30px;font-weight:600">${tick(brand.primary)}${esc(sc.chapter)}</div>`).join('')}</div>
      ${checks.length ? `<div style="background:#fff;color:#101828;border-radius:28px;padding:34px 42px">
        <div style="font-size:24px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${brand.primary};margin-bottom:12px">Check your work</div>
        ${checks.map((c) => `<div style="display:flex;gap:16px;align-items:flex-start;padding:7px 0;font-size:27px">${tick('#12B76A')}<span>${esc(c)}</span></div>`).join('')}</div>` : ''}
    </div></div>`);
}

// Shown over a blurred frame at the start of each chapter.
function chapterHtml(brand, i, n, scene) {
  return base(brand, `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
    <div style="background:#fff;color:#101828;border-radius:28px;padding:56px 80px;min-width:900px;max-width:1400px;box-shadow:0 30px 80px rgba(0,0,0,.35);border-top:10px solid ${brand.primary}">
      <div style="font-size:28px;font-weight:700;color:${brand.primary};letter-spacing:.06em;text-transform:uppercase">Step ${i + 1} of ${n}</div>
      <div style="font-size:72px;font-weight:800;letter-spacing:-.02em;margin-top:12px">${esc(scene.chapter)}</div>
      <div style="display:flex;gap:10px;margin-top:30px">${Array.from({ length: n }, (_, k) => `<div style="height:10px;flex:1;border-radius:6px;background:${k <= i ? brand.primary : '#E4E7EC'}"></div>`).join('')}</div>
    </div></div>`, { transparent: true });
}

// Small label in the bottom-left of the caption band while a chapter plays (never covers the page).
function pillHtml(brand, i, n, scene) {
  return base(brand, `<div style="position:absolute;left:46px;bottom:30px;display:flex;align-items:center;gap:12px;color:#fff;font-size:22px;font-weight:600;max-width:400px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
    <span style="background:${brand.primary};border-radius:999px;padding:4px 14px;font-size:20px">Step ${i + 1}/${n}</span><span style="opacity:.85;overflow:hidden;text-overflow:ellipsis">${esc(scene.chapter)}</span></div>`, { transparent: true });
}

// Logo in the bottom-right of the caption band.
function bugHtml(brand) {
  return base(brand, `<div style="position:absolute;right:46px;bottom:30px;opacity:.85">${brand.logo
    ? `<img src="${brand.logo}" style="max-height:44px;max-width:220px;object-fit:contain" alt="">`
    : `<div class="wordmark" style="font-size:34px">${esc(brand.name)}</div>`}</div>`, { transparent: true });
}

export async function renderCards({ storyboard, brand, outDir }) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const shot = async (html, file, transparent) => {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const p = path.join(outDir, file);
    await page.screenshot({ path: p, omitBackground: transparent });
    return p;
  };
  try {
    const n = storyboard.scenes.length;
    const cards = {
      intro: await shot(introHtml(brand, storyboard), 'card-intro.png', false),
      outro: await shot(outroHtml(brand, storyboard, checksFor(storyboard)), 'card-outro.png', false),
      bug: await shot(bugHtml(brand), 'card-bug.png', true),
      chapters: [], pills: [],
    };
    for (const [i, s] of storyboard.scenes.entries()) {
      cards.chapters.push(await shot(chapterHtml(brand, i, n, s), `card-chapter-${i}.png`, true));
      cards.pills.push(await shot(pillHtml(brand, i, n, s), `card-pill-${i}.png`, true));
    }
    return cards;
  } finally {
    await browser.close();
  }
}
