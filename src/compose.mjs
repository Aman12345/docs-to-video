// Turns the raw recording into the final MP4: smooth zoom on key actions, captions,
// optional narration audio, and a thumbnail. Pure ffmpeg; no browser needed.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const FPS = 30;
const OUT = { width: 1920, height: 1080 };
// The page sits in a 1680x945 frame on a dark canvas, leaving a band underneath for captions
// so they never cover the part of the screen being explained.
const FRAME = { width: 1680, height: 945, x: 120, y: 24 };

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${err.slice(-3000)}`))));
  });
}

const ts = (ms, sep) => {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, x = Math.floor(ms % 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(x).padStart(3, '0')}`;
};

// Eased zoom toward each action marked "zoom": true in the storyboard.
function zoomFilter(timeline) {
  const Z = 1.35, ramp = 0.45;
  const k = OUT.width / timeline.width; // timeline boxes are in page pixels; video is upscaled
  const wins = timeline.actions.filter((a) => a.zoom).map((a) => ({
    s: a.start / 1000 - 0.35, e: a.end / 1000 + 0.5,
    cx: (a.box.x + a.box.w / 2) * k, cy: (a.box.y + a.box.h / 2) * k,
  }));
  if (!wins.length) return null;
  const T = `(on/${FPS})`;
  const ease = (w) => `(${Z - 1})*pow(min(clip((${T}-${w.s.toFixed(3)})/${ramp},0,1),clip((${w.e.toFixed(3)}-${T})/${ramp},0,1)),2)*(3-2*min(clip((${T}-${w.s.toFixed(3)})/${ramp},0,1),clip((${w.e.toFixed(3)}-${T})/${ramp},0,1)))`;
  const z = `1+${wins.map(ease).join('+')}`;
  const pick = (k, dflt) => wins.reduceRight((acc, w) => `if(between(${T},${w.s.toFixed(3)},${w.e.toFixed(3)}),${w[k].toFixed(1)},${acc})`, dflt);
  const x = `clip(${pick('cx', 'iw/2')}-iw/zoom/2,0,iw-iw/zoom)`;
  const y = `clip(${pick('cy', 'ih/2')}-ih/zoom/2,0,ih-ih/zoom)`;
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:fps=${FPS}:s=${FRAME.width}x${FRAME.height}`;
}

// Optional narration through OpenRouter's text-to-speech endpoint. Off unless NARRATION=on,
// so the OpenRouter key can be used for planning without adding a voiceover.
async function narrate(timeline, outDir) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || !/^(on|true|1|yes)$/i.test(process.env.NARRATION || '')) return [];
  const clips = [];
  for (const [i, s] of timeline.scenes.entries()) {
    const res = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.TTS_MODEL || 'openai/gpt-4o-mini-tts-2025-12-15', input: s.narration, voice: process.env.TTS_VOICE || 'nova', response_format: 'mp3' }),
    });
    if (!res.ok) throw new Error(`TTS failed: ${res.status} ${await res.text()}`);
    const file = path.join(outDir, `voice-${i}.mp3`);
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
    clips.push({ file, startMs: s.start + 1600 }); // speak after the chapter card
  }
  return clips;
}

export async function compose({ rawPath, timeline, outDir }) {
  const srt = timeline.scenes.map((s, i) => `${i + 1}\n${ts(s.start + 1600, ',')} --> ${ts(s.end, ',')}\n${s.narration}\n`).join('\n');
  const vtt = 'WEBVTT\n\n' + timeline.scenes.map((s) => `${ts(s.start + 1600, '.')} --> ${ts(s.end, '.')}\n${s.narration}\n`).join('\n');
  const srtPath = path.join(outDir, 'captions.srt');
  await fs.writeFile(srtPath, srt);
  await fs.writeFile(path.join(outDir, 'captions.vtt'), vtt);

  const zoom = zoomFilter(timeline);
  const style = 'FontName=DejaVu Sans,FontSize=10,PrimaryColour=&H00FFFFFF,BorderStyle=1,Outline=0,Shadow=0,MarginV=9';
  const vf = [
    `fps=${FPS}`,
    `scale=${OUT.width}:${OUT.height}:flags=lanczos`,
    zoom || `scale=${FRAME.width}:${FRAME.height}:flags=lanczos`,
    `pad=${OUT.width}:${OUT.height}:${FRAME.x}:${FRAME.y}:color=0x111827`,
    `subtitles=${srtPath}:force_style='${style}'`,
  ].join(',');

  const voice = await narrate(timeline, outDir);
  const args = ['-y', '-i', rawPath];
  voice.forEach((v) => args.push('-i', v.file));
  if (voice.length) {
    const delays = voice.map((v, i) => `[${i + 1}:a]adelay=${v.startMs}|${v.startMs}[a${i}]`).join(';');
    args.push('-filter_complex', `[0:v]${vf}[v];${delays};${voice.map((_, i) => `[a${i}]`).join('')}amix=inputs=${voice.length}:normalize=0[a]`, '-map', '[v]', '-map', '[a]', '-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-vf', vf, '-an');
  }
  const mp4Path = path.join(outDir, 'final.mp4');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4Path);
  await run('ffmpeg', args);

  const thumbPath = path.join(outDir, 'thumbnail.jpg');
  const mid = (timeline.scenes.at(-1).start + 2500) / 1000;
  await run('ffmpeg', ['-y', '-ss', String(mid), '-i', mp4Path, '-frames:v', '1', '-vf', 'scale=640:-2', thumbPath]);

  return {
    mp4Path, thumbPath, vttPath: path.join(outDir, 'captions.vtt'), narrated: voice.length > 0,
    chapters: timeline.scenes.map((s) => ({ title: s.chapter, startSec: Math.round(s.start / 100) / 10 })),
    transcript: timeline.scenes.map((s) => s.narration).join(' '),
    durationSec: Math.round(timeline.scenes.at(-1).end / 100) / 10,
  };
}
