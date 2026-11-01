// Turns the raw recording into the finished, branded MP4 with ffmpeg:
//   purple intro card -> full-screen recording (gentle zoom on clicks, "Step 2 of 4" chip top-right,
//   purple caption pills, small logo, voiceover) -> white closing card, plus MP4 chapter markers.
// Every graphic is a small PNG placed at its own time (input offset), so ffmpeg never buffers frames
// for overlays that aren't due yet; that is what kept memory use high before.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CHAPTER_CARD_MS } from './record.mjs';
import { renderCaptions } from './cards.mjs';

const FPS = 30;
const OUT = { width: 1920, height: 1080 };
// The app fills the whole frame (recorded at 1920x1080).
const FRAME = { width: 1920, height: 1080, x: 0, y: 0 };
// Zoom works on an upscaled copy so its movement is smooth instead of stepping pixel by pixel.
const ZOOM_SRC = { width: 2560, height: 1440 };

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}\n${err.slice(-3000)}`))));
  });
}
// Like run(), but returns ffmpeg's log (analysis filters such as freezedetect write there).
function runLog(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`${cmd} exited ${code}\n${err.slice(-2000)}`))));
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
// texts: array of strings (intro, each scene, outro). Returns one {file, ms} per text, or [].
export async function synthesizeVoice(texts, outDir, log = console.log) {
  if (process.env.TTS_FAKE) { // local testing without a key: a quiet tone as long as the speech would be
    return Promise.all(texts.map(async (text, i) => {
      const file = path.join(outDir, `voice-${i}.m4a`);
      const sec = (text.split(/\s+/).length / 2.7 + 0.4).toFixed(2);
      await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${sec}`, '-af', 'volume=0.05', file]);
      return { file, ms: await mediaMs(file) };
    }));
  }
  if (!narrationOn()) return [];
  try {
    return await Promise.all(texts.map(async (text, i) => {
      const res = await fetch('https://openrouter.ai/api/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.TTS_MODEL || 'mistralai/voxtral-mini-tts-3-0', input: text, voice: process.env.TTS_VOICE || 'en_paul_neutral', response_format: 'mp3' }),
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
  const Z = 1.22, ramp = 0.5; // gentle, so text stays crisp
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
  return `scale=${ZOOM_SRC.width}:${ZOOM_SRC.height}:flags=lanczos,zoompan=z='${z}':x='${x}':y='${y}':d=1:fps=${FPS}:s=${FRAME.width}x${FRAME.height}`;
}

// ---- Dead-time trimming (idea from aidemo) ----
// Finds stretches where nothing on screen moves (page loads, spinners, holds) and cuts what each
// scene doesn't need for its narration. Cuts inside frozen footage are invisible to the viewer.
// Never cuts the chapter card, the cursor gliding to a control, a click or typing.
async function detectFreezes(rawPath) {
  const log = await runLog('ffmpeg', ['-hide_banner', '-i', rawPath, '-vf', 'freezedetect=n=0.002:d=0.6', '-map', '0:v', '-f', 'null', '-']);
  const starts = [...log.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => Number(m[1]) * 1000);
  const ends = [...log.matchAll(/freeze_end: ([\d.]+)/g)].map((m) => Number(m[1]) * 1000);
  return starts.map((st, i) => ({ start: st, end: ends[i] ?? Infinity }));
}

function idleCuts(tl, freezes, voice) {
  const card = CHAPTER_CARD_MS;
  const existing = tl.cuts || [];
  const cuts = [];
  tl.scenes.forEach((s, i) => {
    const words = (s.narration || '').split(/\s+/).length;
    const last = i === tl.scenes.length - 1;
    // What the scene must keep: the chapter card plus the voiceover (or time to read the caption).
    const need = (voice[i] ? card + voice[i].ms + 700 : Math.max(3200, card + (words / 2.6) * 1000 + 700)) + (last ? 1000 : 0);
    const already = existing.filter((c) => c.start >= s.start && c.end <= s.end).reduce((n, c) => n + c.end - c.start, 0);
    let removable = s.end - s.start - already - need;
    if (removable < 400) return;
    const protect = [[s.start, s.start + card + 300],
      ...tl.actions.filter((a) => a.scene === i).map((a) => [a.start - 1500, a.end + 200]),
      ...existing.map((c) => [c.start - 400, c.end + 400])];
    const segs = [];
    for (const f of freezes) {
      let pieces = [[Math.max(f.start, s.start) + 250, Math.min(f.end, s.end) - 250]];
      for (const [pa, pb] of protect) pieces = pieces.flatMap(([a, b]) => (pb <= a || pa >= b ? [[a, b]] : [[a, pa], [pb, b]]));
      segs.push(...pieces.filter(([a, b]) => b - a >= 350));
    }
    segs.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]));
    for (const [a, b] of segs) {
      if (removable < 300) break;
      const len = Math.min(b - a, removable);
      const mid = (a + b) / 2;
      cuts.push({ start: Math.round(mid - len / 2), end: Math.round(mid + len / 2), kind: 'idle' });
      removable -= len;
    }
  });
  return cuts;
}

// Long waits are cut out: shift every later time back by the trimmed amount.
function applyCuts(tl) {
  const cuts = (tl.cuts || []).filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
  if (!cuts.length) return { timeline: tl, cuts: [], select: '', trimmedSec: 0 };
  const map = (t) => t - cuts.reduce((n, c) => n + (t >= c.end ? c.end - c.start : t > c.start ? t - c.start : 0), 0);
  const timeline = {
    ...tl,
    scenes: tl.scenes.map((s) => ({ ...s, start: map(s.start), end: map(s.end) })),
    actions: tl.actions.map((a) => ({ ...a, start: map(a.start), end: map(a.end) })),
  };
  const keep = `not(${cuts.map((c) => `between(t,${(c.start / 1000).toFixed(3)},${(c.end / 1000).toFixed(3)})`).join('+')})`;
  return {
    timeline,
    // Only long waits get an "N minutes later" label; trimmed idle moments are seamless.
    cuts: cuts.filter((c) => c.kind !== 'idle').map((c) => ({ at: map(c.start) / 1000, skippedSec: (c.end - c.start) / 1000 })),
    trimmedSec: cuts.reduce((n, c) => n + c.end - c.start, 0) / 1000,
    select: `select='${keep}',setpts=N/${FPS}/TB,`,
  };
}

const laterText = (sec) => (sec >= 90 ? `About ${Math.round(sec / 60)} minutes later` : `${Math.round(sec / 5) * 5} seconds later`);

// voice: one clip per scene; introVoice / outroVoice: the spoken intro and outro (or null).
export async function compose({ rawPath, timeline: rawTimeline, outDir, brand, cards, voice = [], introVoice = null, outroVoice = null, introText = '', outroText = '', storyboard }) {
  // Intro and outro cards last as long as their voiceover (or long enough to read the step list).
  const n = rawTimeline.scenes.length;
  const INTRO = Math.max(3.2, introVoice ? introVoice.ms / 1000 + 1.3 : 2.4 + 0.5 * n);
  const OUTRO = Math.max(3.6, outroVoice ? outroVoice.ms / 1000 + 1.6 : 2.8 + 0.4 * n);
  const freezes = await detectFreezes(rawPath).catch(() => []);
  const idle = idleCuts(rawTimeline, freezes, voice);
  const { timeline, cuts, select, trimmedSec } = applyCuts({ ...rawTimeline, cuts: [...(rawTimeline.cuts || []), ...idle] });
  const rawDur = timeline.scenes.at(-1).end / 1000 + 0.4;
  const total = INTRO + rawDur + OUTRO;
  const card = CHAPTER_CARD_MS / 1000;
  const scenes = timeline.scenes.map((s) => ({ ...s, a: s.start / 1000, b: s.end / 1000 }));

  // Captions: short chunks (a few words each) timed across the spoken sentence, shifted for the intro.
  const cues = scenes.flatMap((s, i) => {
    const from = INTRO + s.a + card + 0.15;
    const span = voice[i] ? voice[i].ms / 1000 : Math.max(1.5, s.b - s.a - card - 0.4);
    const chunks = captionChunks(s.narration, Math.max(1, Math.floor(span / 1.8)));
    const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
    let t = from;
    return chunks.map((text, k) => {
      const dur = (span * text.length) / total;
      const cue = { from: t, to: k === chunks.length - 1 ? Math.max(t + dur, INTRO + s.b - 0.1) : t + dur, text, scene: i };
      t += dur;
      return cue;
    });
  });
  // Captions for the spoken intro and outro.
  const bookend = (text, from, span) => {
    const chunks = captionChunks(text, Math.max(1, Math.floor(span / 1.8)));
    const len = chunks.reduce((k, c) => k + c.length, 0) || 1;
    let t = from;
    return chunks.map((c) => { const d = (span * c.length) / len; const cue = { from: t, to: t + d, text: c }; t += d; return cue; });
  };
  if (introText) cues.unshift(...bookend(introText, 0.5, introVoice ? introVoice.ms / 1000 : INTRO - 0.9));
  if (outroText) cues.push(...bookend(outroText, INTRO + rawDur + 0.6, outroVoice ? outroVoice.ms / 1000 : OUTRO - 1.0));
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

  // Graphics: caption pills (step narration only; the intro and closing cards carry their own text),
  // "N minutes later" labels, step chips, the logo, and the full-screen intro and closing cards.
  const stepCues = cues.filter((c) => c.scene !== undefined);
  const pills = await renderCaptions({ texts: [...stepCues.map((c) => c.text), ...cuts.map((c) => laterText(c.skippedSec))], brand, outDir });
  const overlays = []; // { file, x, y, start, dur, fadeIn, fadeOut }
  const W = OUT.width, H = OUT.height;
  overlays.push({ ...cards.logo, x: W - 38 - cards.logo.w, y: H - 50 - cards.logo.h, start: INTRO, dur: rawDur, fadeIn: 0.3, fadeOut: 0.3 });
  scenes.forEach((s, i) => {
    const chip = cards.chips[i];
    overlays.push({ ...chip, x: W - 20 - chip.w, y: 14, start: INTRO + s.a + 0.1, dur: Math.max(0.6, s.b - s.a - 0.15), fadeIn: 0.3, fadeOut: 0.2 });
  });
  stepCues.forEach((c, k) => {
    const pill = pills[k];
    overlays.push({ ...pill, x: Math.round((W - pill.w) / 2), y: H - 14 - pill.h, start: c.from, dur: Math.max(0.4, c.to - c.from), fadeIn: 0.15, fadeOut: 0.15 });
  });
  cuts.forEach((c, k) => {
    const pill = pills[stepCues.length + k];
    overlays.push({ ...pill, x: Math.round((W - pill.w) / 2), y: 40, start: INTRO + c.at, dur: 2.6, fadeIn: 0.2, fadeOut: 0.3 });
  });
  overlays.push({ file: cards.intro, x: 0, y: 0, start: 0, dur: INTRO, fadeIn: 0, fadeOut: 0.4 });
  overlays.push({ file: cards.outro, x: 0, y: 0, start: INTRO + rawDur, dur: OUTRO, fadeIn: 0.4, fadeOut: 0 });

  // Inputs: 0 = recording, then each graphic starting at its own time, then voice clips, then chapters.
  const args = ['-y', '-i', rawPath];
  overlays.forEach((o) => args.push('-itsoffset', o.start.toFixed(3), '-loop', '1', '-framerate', String(FPS), '-t', o.dur.toFixed(3), '-i', o.file));
  const voiceStart = 1 + overlays.length;
  // Every spoken clip and when it starts: intro, each step (just after its chip appears), outro.
  const clips = [
    ...(introVoice ? [{ file: introVoice.file, at: 0.5 }] : []),
    ...voice.map((v, i) => ({ file: v.file, at: INTRO + scenes[i].a + card + 0.15 })),
    ...(outroVoice ? [{ file: outroVoice.file, at: INTRO + rawDur + 0.6 }] : []),
  ];
  clips.forEach((c) => args.push('-i', c.file));
  const metaIdx = voiceStart + clips.length;
  args.push('-f', 'ffmetadata', '-i', metaPath);

  // Video graph: trim waits, gentle zoom on clicks, hold the first/last frame under the intro/closing cards.
  const g = [
    `[0:v]fps=${FPS},${select}${zoomFilter(timeline)},setsar=1,`
    + `tpad=start_duration=${INTRO}:start_mode=clone:stop_duration=${OUTRO}:stop_mode=clone[v0]`,
  ];
  overlays.forEach((o, i) => {
    const end = o.start + o.dur;
    const fades = [o.fadeIn ? `fade=t=in:st=${o.start.toFixed(3)}:d=${o.fadeIn}:alpha=1` : null, o.fadeOut ? `fade=t=out:st=${(end - o.fadeOut).toFixed(3)}:d=${o.fadeOut}:alpha=1` : null].filter(Boolean);
    g.push(`[${i + 1}:v]format=rgba${fades.length ? `,${fades.join(',')}` : ''}[o${i}]`);
    g.push(`[v${i}][o${i}]overlay=${o.x}:${o.y}:enable='between(t,${o.start.toFixed(3)},${end.toFixed(3)})':eof_action=pass[v${i + 1}]`);
  });
  g.push(`[v${overlays.length}]format=yuv420p[vout]`);

  // Audio graph: each clip placed at its start time.
  if (clips.length) {
    clips.forEach((c, i) => {
      const at = Math.round(c.at * 1000);
      g.push(`[${voiceStart + i}:a]aresample=48000,adelay=${at}|${at}[a${i}]`);
    });
    g.push(`${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,apad[aout]`);
  }

  const mp4Path = path.join(outDir, 'final.mp4');
  args.push('-filter_complex', g.join(';'), '-map', '[vout]');
  if (clips.length) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '160k');
  args.push('-map_metadata', String(metaIdx), '-map_chapters', String(metaIdx),
    '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-tune', 'stillimage', '-r', String(FPS),
    '-movflags', '+faststart', mp4Path);
  await run('ffmpeg', args);

  // Thumbnail: the branded intro card.
  const thumbPath = path.join(outDir, 'thumbnail.jpg');
  await run('ffmpeg', ['-y', '-i', cards.intro, '-frames:v', '1', '-vf', 'scale=640:-2', thumbPath]);

  // One screenshot per step for the written SOP, from the clean recording (no captions, chips or zoom),
  // just before the step ends, when its result is on screen.
  const stepFrames = [];
  for (const [i, s] of rawTimeline.scenes.entries()) {
    const file = path.join(outDir, `step-${i + 1}.jpg`);
    await run('ffmpeg', ['-y', '-ss', Math.max(0, s.end / 1000 - 0.6).toFixed(3), '-i', rawPath, '-frames:v', '1',
      '-vf', 'scale=1280:-2:flags=lanczos', '-q:v', '3', file]);
    stepFrames.push(file);
  }
  const qa = await qualityCheck({ mp4Path, stepFrames, cues, narrated: voice.length > 0, total, scenes });

  return {
    mp4Path, thumbPath, stepFrames, qa, trimmedSec: Math.round(trimmedSec * 10) / 10, vttPath: path.join(outDir, 'captions.vtt'), narrated: voice.length > 0,
    chapters: scenes.map((s) => ({ title: s.chapter, startSec: Math.round((INTRO + s.a) * 10) / 10 })),
    transcript: [introText, ...scenes.map((s) => s.narration), outroText].filter(Boolean).join(' '),
    durationSec: Math.round(total * 10) / 10,
  };
}

// Splits a sentence into caption chunks of about 7-9 words (one readable line), preferring breaks
// after punctuation, never leaving a tiny last chunk.
function captionChunks(text, maxChunks) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const per = Math.max(7, Math.ceil(words.length / Math.max(1, maxChunks)));
  const out = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    const left = words.length - i - 1;
    const atPunct = /[,.;:!?]$/.test(w) && cur.length >= 4;
    if ((cur.length >= per || (atPunct && cur.length >= per - 3)) && left >= 3) { out.push(cur.join(' ')); cur = []; }
  });
  if (cur.length) out.push(cur.join(' '));
  return out;
}

// ---- Quality checks on the finished file (idea from aidemo's qa) ----
// Warnings, not failures: the video is still saved, and the dashboard shows what to look at.
async function qualityCheck({ mp4Path, stepFrames, cues, narrated, total, scenes }) {
  const warnings = [];
  for (const [i, f] of stepFrames.entries()) {
    // Edge density: real screens (text, buttons, tables) score about 1-5; a blank or loading page is near 0.
    const log = await runLog('ffmpeg', ['-hide_banner', '-i', f, '-vf', 'edgedetect=low=0.1:high=0.3,signalstats,metadata=print', '-f', 'null', '-']).catch(() => '');
    const edges = Number(/YAVG=([\d.]+)/.exec(log)?.[1]);
    if (Number.isFinite(edges) && edges < 0.15) warnings.push(`Step ${i + 1} ("${scenes[i].chapter}") ends on an almost blank screen. The page may not have loaded.`);
  }
  if (narrated) {
    const log = await runLog('ffmpeg', ['-hide_banner', '-i', mp4Path, '-vn', '-af', 'volumedetect', '-f', 'null', '-']).catch(() => '');
    const max = Number(/max_volume: (-?[\d.]+) dB/.exec(log)?.[1]);
    if (!Number.isFinite(max) || max < -30) warnings.push('The voiceover is silent or very quiet.');
  }
  const flash = cues.filter((c) => c.to - c.from < 1.0);
  if (flash.length) warnings.push(`${flash.length} caption${flash.length > 1 ? 's' : ''} show for under a second (hard to read).`);
  if (total > 180) warnings.push(`The video is ${Math.round(total)}s long; how-to videos work best under 2 minutes. Consider splitting it.`);
  return { ok: warnings.length === 0, warnings, checkedAt: new Date().toISOString() };
}
