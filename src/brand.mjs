// Brand kit for the videos. Everything is a setting, so Miter's real logo and colours can be
// dropped in without code changes:
//   BRAND_NAME        e.g. "Miter"
//   BRAND_PRIMARY     main accent colour, Miter purple "#680BBD" by default (highlights, step labels, ripples)
//   BRAND_DARK        background of the frame and caption band, Miter midnight "#260F14" by default
//   BRAND_LOGO_URL    https link to a PNG or SVG logo (or put a file at brand/logo.svg / brand/logo.png)
//   BRAND_TAGLINE     small line on the intro card, e.g. "Miter Help Center"
//   BRAND_SUPPORT     line on the closing card, e.g. "Questions? Chat with us in Miter"
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let cached;

async function logoDataUri(variant = '') {
  const url = variant ? process.env.BRAND_LOGO_DARK_URL : process.env.BRAND_LOGO_URL;
  try {
    if (url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`logo download ${res.status}`);
      const type = res.headers.get('content-type') || (url.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
      return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
    }
    for (const [file, type] of [[`brand/logo${variant}.svg`, 'image/svg+xml'], [`brand/logo${variant}.png`, 'image/png']]) {
      const buf = await fs.readFile(path.join(ROOT, file)).catch(() => null);
      if (buf) return `data:${type};base64,${buf.toString('base64')}`;
    }
  } catch (e) {
    console.error(`Brand logo not loaded: ${e.message}`);
  }
  return null;
}

export async function getBrand() {
  if (cached) return cached;
  const hex = (v, d) => (/^#?[0-9a-f]{6}$/i.test(v || '') ? `#${v.replace('#', '')}` : d);
  cached = {
    name: process.env.BRAND_NAME || 'Miter',
    primary: hex(process.env.BRAND_PRIMARY, '#680BBD'),
    dark: hex(process.env.BRAND_DARK, '#260F14'),
    tagline: process.env.BRAND_TAGLINE || `${process.env.BRAND_NAME || 'Miter'} Help Center`,
    support: process.env.BRAND_SUPPORT || `Questions? Ask ${process.env.BRAND_NAME || 'Miter'} AI or reach out to ${process.env.BRAND_NAME || 'Miter'} support.`,
    logo: await logoDataUri(), // for purple / dark backgrounds
    logoDark: await logoDataUri('-dark'), // for white backgrounds (brand/logo-dark.svg or BRAND_LOGO_DARK_URL)
  };
  return cached;
}

// ffmpeg wants colours as 0xRRGGBB.
export const ffColor = (hex) => `0x${hex.replace('#', '')}`;
