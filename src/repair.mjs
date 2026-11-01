// AI takeover: when a saved step stops working while a video is being recorded (a renamed or moved
// button, a new popup, a page that loads slowly), the AI looks at the screen and fixes it so the
// recording can carry on. It works through OpenRouter (REPAIR_MODEL). Its fix is saved into the
// video's steps, so the next re-record works without the AI. The time spent thinking is cut from the video.
import { repairModel, chat, parseJson, snapshot, describe } from './ai.mjs';
import { get } from './settings.mjs';

const SYSTEM = `You are fixing a how-to video while it is being recorded. The video replays saved browser steps.
One step just failed, usually because the app changed: a button was renamed or moved, a popup or banner is
in the way, a menu must be opened first, or the page is still loading.

You get a screenshot, an accessibility snapshot of the page (YAML lines like: - button "Save"), the step that
failed with its error, and what the video is about. Reply with ONLY one JSON object:
{"do": "click" | "fill" | "select" | "press" | "goto" | "scroll" | "wait" | "fail",
 "target": {"role": "button", "name": "Save"},   // or {"label": ...}, {"placeholder": ...}, {"text": ...}; add "nth" if several match
 "value": "text (fill) or option label (select)", "key": "Enter", "url": "https://...",
 "text": "...", "seconds": 10, "gone": true,     // for wait: wait for text to appear (or disappear with gone), or just seconds
 "use": "instead" | "first",
 "why": "short reason, written for the person who reviews the video"}

- "use": "instead" means your action does what the failed step was meant to do (e.g. the button is now
  called something else). "use": "first" means something must happen before the failed step can work
  (close a popup, wait for the page to finish loading, scroll, open a menu); the failed step is tried again after.
- If the page is still loading or blank, reply {"do":"wait","seconds":10,"use":"first"} (or wait for text).
- Do only what the failed step was meant to do. Never skip ahead, add extra steps to the video, or change
  what the video shows.
- Copy roles and names exactly from the snapshot.
- Never do anything that can't be undone or that reaches other people (submit, send, approve, pay, delete,
  invite, publish, change settings) unless the failed step itself was that action. Never type passwords,
  payment or personal details. Close unrelated popups and choose decline / necessary-only on cookie banners.
- Reply {"do":"fail","why":"..."} if the feature seems gone, a sign-in page or robot check appears, or you
  can't tell how to fix it.`;

// act(step): performs a step on screen the same way the recorder does (cursor glide, ring, click); throws if it fails.
// clock(): ms since the recording started, used to mark the thinking time so it can be cut.
export async function takeOver(page, { storyboard, scene, step, error, done, act, clock, usage, log = console.log }) {
  const MAX_TURNS = Math.min(Math.max(Number(get('repairMaxTurns')) || 4, 1), 8);
  const REPAIR_MODEL = repairModel();
  const tried = [];
  const extra = []; // "first" actions that worked
  const pauses = [];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const t0 = clock();
    const shot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
    const text = [
      `The video: ${storyboard.title}${storyboard.prompt ? ` (requested as: "${storyboard.prompt}")` : ''}`,
      `This part of the video: "${scene.chapter}". Narration: "${scene.narration || ''}"`,
      `Steps that already worked in this recording:\n${done.slice(-8).map((d, k) => `${k + 1}. ${describe(d)}`).join('\n') || '(none)'}`,
      `The step that failed: ${describe(step)}\nError: ${String(error?.message || error).split('\n')[0].slice(0, 300)}`,
      tried.length ? `Your earlier tries for this step:\n${tried.join('\n')}` : '',
      `Current URL: ${page.url()}`,
      `Accessibility snapshot:\n${await snapshot(page)}`,
    ].filter(Boolean).join('\n\n');
    const withImage = shot ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${shot.toString('base64')}` } }] : text;
    let reply;
    try {
      reply = parseJson(await chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: withImage }], usage, { model: REPAIR_MODEL, maxTokens: 600 }));
    } catch (e) {
      if (!shot) throw e; // models that can't read images get the text alone
      reply = parseJson(await chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: text }], usage, { model: REPAIR_MODEL, maxTokens: 600 }));
    }
    pauses.push({ start: t0, end: clock() });
    if (reply.do === 'fail') throw new Error(`The AI could not fix this step: ${reply.why || 'no reason given'}`);

    const fix = { do: reply.do, target: reply.target, value: reply.value, key: reply.key, url: reply.url, text: reply.text, seconds: reply.seconds, gone: reply.gone === true };
    for (const k of Object.keys(fix)) if (fix[k] === undefined || fix[k] === null || fix[k] === false) delete fix[k];
    if (fix.do === 'wait') { delete fix.target; fix.seconds = Math.min(Number(fix.seconds) || 10, 300); }
    if (['click', 'fill', 'select'].includes(fix.do)) fix.zoom = true;
    const use = fix.do === 'wait' || fix.do === 'scroll' ? 'first' : reply.use === 'instead' ? 'instead' : 'first';
    log(`AI takeover: ${describe(fix)} (${use}) - ${reply.why || ''}`);
    try {
      await act(fix);
    } catch (e) {
      tried.push(`${describe(fix)} -> FAILED: ${e.message.split('\n')[0].slice(0, 200)}`);
      continue;
    }
    if (use === 'instead') {
      return { steps: [...extra, fix], why: reply.why || 'The step was changed to match the app.', pauses };
    }
    extra.push(fix);
    try {
      await act(step);
      return { steps: [...extra, step], why: reply.why || 'An extra step was needed first.', pauses };
    } catch (e) {
      tried.push(`${describe(fix)} -> ok, but the failed step still failed: ${e.message.split('\n')[0].slice(0, 200)}`);
    }
  }
  throw new Error(`The AI could not fix this step after ${MAX_TURNS} tries.`);
}
