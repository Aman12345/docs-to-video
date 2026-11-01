// Turns the raw recording into the finished, branded MP4 with ffmpeg:
//   intro card -> recording (eased zoom, chapter cards over a blurred frame, "Step 2/4" label,
//   logo in the caption band, captions, voiceover) -> closing card, plus MP4 chapter markers.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ffColor } from './brand.mjs';
import { CHAPTER_CARD_MS } from './record.mjs';

const FPS = 30;
const OUT = { width: 1920, height: 1080 };
// The page sits in a frame on the brand background, leaving a band underneath for captions.
const FRAME = { width: 1680, height: 945, x: 120, y: 24 };
// Zoom works on an upscaled copy so its movement is smooth instead of stepping pixel by pixel.
const ZOOM_SRC = { width: 2560, height: 1440 };
const INTRO = 2.8, OUTRO = 3.2;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}\n${err.slice(-3000)}`))));
  });
}
const mediaMs = async (file) => Math.round(Number(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])) * 1000);

const ts = (sec, sep) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, x = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(x).padStart(3, '0')}`;
};

export const narrationOn = () => /^(on|true|1|yes)$/i.test(process.env.NARRATION || '') && !!process.env.OPENROUTER_API_KEY;

// Voiceover per scene through OpenRouter text-to-speech, made BEFORE recording so each scene can
// be held long enough for its sentence. Returns [{file, ms}] per scene, or [] if narration is off
// or fails (the video then simply has captions only).
export async function synthesizeVoice(scenes, outDir, log = console.log) {
  if (process.env.TTS_FAKE) { // local testing without a key: a quiet tone as long as the speech would be
    return Promise.all(scenes.map(async (s, i) => {
      const file = path.join(outDir, `voice-${i}.m4a`);
      const sec = (s.narration.split(/\s+/).length / 2.7 + 0.4).toFixed(2);
      await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${sec}`, '-af', 'volume=0.05', file]);
      return { file, ms: await mediaMs(file) };
    }));
  }
  if (!narrationOn()) return [];
  try {
    return await Promise.all(scenes.map(async (s, i) => {
      const res = await fetch('https://openrouter.ai/api/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.TTS_MODEL || 'mistralai/voxtral-mini-tts-3-0', input: s.narration, voice: process.env.TTS_VOICE || 'en_paul_neutral', response_format: 'mp3' }),
      });
      if (!res.ok) throw new Error(`TTS ${res.status} ${(await res.text()).slice(0, 200)}`);
      const file = path.join(outDir, `voice-${i}.mp3`);
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      return { file, ms: await mediaMs(file) };
    }));
  } catch (e) {
    log(`narration skipped: ${e.message.slice(0, 200)}`);
    return [];
  }
}

// Eased zoom toward each action marked "zoom": true in the storyboard.
function zoomFilter(timeline) {
  const Z = 1.35, ramp = 0.5;
  const k = ZOOM_SRC.width / timeline.width;
  const wins = timeline.actions.filter((a) => a.zoom).map((a) => ({
    s: a.start / 1000 - 0.45, e: a.end / 1000 + 0.5,
    cx: (a.box.x + a.box.w / 2) * k, cy: (a.box.y + a.box.h / 2) * k,
  }));
  if (!wins.length) return `scale=${FRAME.width}:${FRAME.height}:flags=lanczos`;
  const T = `(on/${FPS})`;
  const m = (w) => `min(clip((${T}-${w.s.toFixed(3)})/${ramp},0,1),clip((${w.e.toFixed(3)}-${T})/${ramp},0,1))`;
  const z = `1+${wins.map((w) => `${Z - 1}*pow(${m(w)},2)*(3-2*${m(w)})`).join('+')}`;
  const pick = (key, dflt) => wins.reduceRight((acc, w) => `if(between(${T},${w.s.toFixed(3)},${w.e.toFixed(3)}),${w[key].toFixed(1)},${acc})`, dflt);
  const x = `clip(${pick('cx', 'iw/2')}-iw/zoom/2,0,iw-iw/zoom)`;
  const y = `clip(${pick('cy', 'ih/2')}-ih/zoom/2,0,ih-ih/zoom)`;
  return `scale=${ZOOM_SRC.width}:${ZOOM_SRC.height}:flags=bicubic,zoompan=z='${z}':x='${x}':y='${y}':d=1:fps=${FPS}:s=${FRAME.width}x${FRAME.height}`;
}

export async function compose({ rawPath, timeline, outDir, brand, cards, voice = [], storyboard }) {
  const rawDur = timeline.scenes.at(-1).end / 1000 + 0.4;
  const total = INTRO + rawDur + OUTRO;
  const card = CHAPTER_CARD_MS / 1000;
  const scenes = timeline.scenes.map((s) => ({ ...s, a: s.start / 1000, b: s.end / 1000 }));

  // Captions, shifted to make room for the intro card.
  const cues = scenes.map((s) => ({ from: INTRO + s.a + card, to: INTRO + s.b, text: s.narration }));
  const srtPath = path.join(outDir, 'captions.srt');
  await fs.writeFile(srtPath, cues.map((c, i) => `${i + 1}\n${ts(c.from, ',')} --> ${ts(c.to, ',')}\n${c.text}\n`).join('\n'));
  await fs.writeFile(path.join(outDir, 'captions.vtt'), `WEBVTT\n\n${cues.map((c) => `${ts(c.from, '.')} --> ${ts(c.to, '.')}\n${c.text}\n`).join('\n')}`);

  // MP4 chapter markers (players like QuickTime and VLC show them).
  const metaPath = path.join(outDir, 'chapters.txt');
  const chap = (start, end, title) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(start * 1000)}\nEND=${Math.round(end * 1000)}\ntitle=${title.replace(/[=;#\\\n]/g, ' ')}\n`;
  await fs.writeFile(metaPath, `;FFMETADATA1\ntitle=${storyboard.title.replace(/[=;#\\\n]/g, ' ')}\n`
    + chap(0, INTRO, 'Introduction')
    + scenes.map((s, i) => chap(INTRO + s.a, INTRO + s.b, `Step ${i + 1}: ${s.chapter}`)).join('')
    + chap(INTRO + rawDur, total, 'Done'));

  // Inputs: 0 = recording, then the card images, then voice clips, then chapter metadata.
  const args = ['-y', '-i', rawPath];
  const overlays = []; // { file, start, dur, fadeIn, fadeOut }
  overlays.push({ file: cards.bug, start: INTRO, dur: rawDur, fadeIn: 0.3, fadeOut: 0.3 });
  scenes.forEach((s, i) => {
    overlays.push({ file: cards.pills[i], start: INTRO + s.a + card, dur: Math.max(0.5, s.b - s.a - card), fadeIn: 0.25, fadeOut: 0.2 });
    overlays.push({ file: cards.chapters[i], start: INTRO + s.a + 0.05, dur: card - 0.1, fadeIn: 0.2, fadeOut: 0.25 });
  });
  overlays.push({ file: cards.intro, start: 0, dur: INTRO, fadeIn: 0, fadeOut: 0.4 });
  overlays.push({ file: cards.outro, start: INTRO + rawDur, dur: OUTRO, fadeIn: 0.4, fadeOut: 0 });
  overlays.forEach((o) => args.push('-loop', '1', '-framerate', String(FPS), '-t', o.dur.toFixed(3), '-i', o.file));
  const voiceStart = 1 + overlays.length;
  voice.forEach((v) => args.push('-i', v.file));
  const metaIdx = voiceStart + voice.length;
  args.push('-f', 'ffmetadata', '-i', metaPath);

  // Video graph.
  const blur = scenes.map((s) => `between(t,${s.a.toFixed(3)},${(s.a + card).toFixed(3)})`).join('+');
  const g = [
    `[0:v]fps=${FPS},${zoomFilter(timeline)},boxblur=luma_radius=14:luma_power=2:enable='${blur}',`
    + `pad=${OUT.width}:${OUT.height}:${FRAME.x}:${FRAME.y}:color=${ffColor(brand.dark)},`
    + `tpad=start_duration=${INTRO}:start_mode=clone:stop_duration=${OUTRO}:stop_mode=clone[v0]`,
  ];
  overlays.forEach((o, i) => {
    const fades = [o.fadeIn ? `fade=t=in:st=0:d=${o.fadeIn}:alpha=1` : null, o.fadeOut ? `fade=t=out:st=${(o.dur - o.fadeOut).toFixed(3)}:d=${o.fadeOut}:alpha=1` : null].filter(Boolean);
    g.push(`[${i + 1}:v]format=rgba,${fades.length ? `${fades.join(',')},` : ''}setpts=PTS-STARTPTS+${o.start.toFixed(3)}/TB[o${i}]`);
    g.push(`[v${i}][o${i}]overlay=0:0:enable='between(t,${o.start.toFixed(3)},${(o.start + o.dur).toFixed(3)})':eof_action=pass[v${i + 1}]`);
  });
  const style = `FontName=Inter,FontSize=10,PrimaryColour=&H00FFFFFF,OutlineColour=&H66000000,BorderStyle=1,Outline=0.6,Shadow=0,MarginV=10,MarginL=90,MarginR=90`; // side margins keep text clear of the step label and logo
  g.push(`[v${overlays.length}]subtitles=${srtPath}:force_style='${style}',format=yuv420p[vout]`);

  // Audio graph: each scene's voice starts just after its chapter card.
  if (voice.length) {
    voice.forEach((v, i) => {
      const at = Math.round((INTRO + scenes[i].a + card + 0.15) * 1000);
      g.push(`[${voiceStart + i}:a]aresample=48000,adelay=${at}|${at}[a${i}]`);
    });
    g.push(`${voice.map((_, i) => `[a${i}]`).join('')}amix=inputs=${voice.length}:normalize=0,apad[aout]`);
  }

  const mp4Path = path.join(outDir, 'final.mp4');
  args.push('-filter_complex', g.join(';'), '-map', '[vout]');
  if (voice.length) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '160k');
  args.push('-map_metadata', String(metaIdx), '-map_chapters', String(metaIdx),
    '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', String(FPS),
    '-movflags', '+faststart', mp4Path);
  await run('ffmpeg', args);

  // Thumbnail: the branded intro card.
  const thumbPath = path.join(outDir, 'thumbnail.jpg');
  await run('ffmpeg', ['-y', '-ss', '1.2', '-i', mp4Path, '-frames:v', '1', '-vf', 'scale=640:-2', thumbPath]);

  return {
    mp4Path, thumbPath, vttPath: path.join(outDir, 'captions.vtt'), narrated: voice.length > 0,
    chapters: scenes.map((s) => ({ title: s.chapter, startSec: Math.round((INTRO + s.a) * 10) / 10 })),
    transcript: scenes.map((s) => s.narration).join(' '),
    durationSec: Math.round(total * 10) / 10,
  };
}
