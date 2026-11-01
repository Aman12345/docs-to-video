// "Check your work": every video ends by showing the finished result. The AI looks at the final screen,
// clears anything covering the result (a chat panel, a popup), picks the element that shows it, and
// writes one spoken sentence about what the viewer should see. The recorder then highlights that element
// and holds on it. The scene is saved with the video's steps, so later re-records replay it with no AI.
import { repairModel, chat, parseJson, snapshot, describe } from './ai.mjs';

export const CHECK_CHAPTER = 'Check your work';
export const isCheck = (scene) => !!scene?.check;

const SYSTEM = `A how-to video has just finished its steps. It should end on a short "Check your work" moment
that shows the viewer the finished result, so they know what success looks like.

You get a screenshot, an accessibility snapshot (YAML lines like: - table "Earnings"), what the video is
about and the steps that were done. Reply with ONLY one JSON object:
{"reveal": [ ...0 to 3 actions that make the result fully visible... ],
 "show": {"role": "table", "name": "Earnings by pay period"},   // or {"label"|"text"|"testId": ...}; add "nth" if several match
 "chapter": "2-4 word title, verb first, e.g. Check the report",
 "narration": "one or two short spoken sentences, max 25 words, saying what the viewer should now see"}

Each reveal action: {"do": "click" | "press" | "scroll" | "wait", "target": {...}, "key": "Escape", "seconds": 3}

- "show" is the element that best shows the outcome (the new record, the finished report or table, the
  confirmation message). Prefer the main content over a chat reply that only describes it.
- Use "reveal" only when something covers or hides the result: close a side panel or popup, or scroll to the
  result. Leave it empty if the result is already in full view. Never click Save, Submit, Send, Approve,
  Delete, Publish or anything else that changes data or reaches other people.
- Copy roles and names exactly from the snapshot.
- Narration: calm, friendly, "you", present tense, exact labels, e.g. "Your new report lists each team member's
  regular, overtime and total earnings for every pay period." No "simply", "just", "as you can see".
- If the result isn't on screen and you can't reveal it safely, reply {"skip": "why"}.`;

// Returns {reveal, show, chapter, narration} or null (skipped).
export async function planCheck(page, { storyboard, usage, log = console.log, tryShow, note }) {
  const steps = storyboard.scenes.flatMap((s) => s.steps).filter((s) => s.do !== 'pause');
  // note: a reviewer's finding about the previous ending ("it shows the title, not the report").
  let feedback = note ? `A reviewer said the previous ending was wrong: ${note}` : '';
  for (let turn = 0; turn < 2; turn++) {
    const shot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
    const text = [
      `The video: ${storyboard.title}${storyboard.prompt ? ` (requested as: "${storyboard.prompt}")` : ''}`,
      storyboard.checks?.length ? `What the viewer should be able to check: ${storyboard.checks.join('; ')}` : '',
      `Steps done:\n${steps.slice(-10).map((s, k) => `${k + 1}. ${describe(s)}`).join('\n')}`,
      feedback,
      `Current URL: ${page.url()}`,
      `Accessibility snapshot:\n${await snapshot(page)}`,
    ].filter(Boolean).join('\n\n');
    const content = shot ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${shot.toString('base64')}` } }] : text;
    const reply = parseJson(await chat([{ role: 'system', content: SYSTEM }, { role: 'user', content }], usage, { model: repairModel(), maxTokens: 700 }));
    if (reply.skip || !reply.show) { log(`check your work: skipped (${reply.skip || 'no result element'})`); return null; }
    const plan = {
      reveal: (Array.isArray(reply.reveal) ? reply.reveal : []).slice(0, 3)
        .filter((a) => ['click', 'press', 'scroll', 'wait'].includes(a?.do))
        .map((a) => ({ do: a.do, ...(a.target ? { target: a.target } : {}), ...(a.key ? { key: a.key } : {}), ...(a.do === 'wait' ? { seconds: Math.min(Number(a.seconds) || 2, 10) } : {}), ...(a.dy ? { dy: a.dy } : {}) })),
      show: reply.show,
      chapter: String(reply.chapter || CHECK_CHAPTER).slice(0, 40),
      narration: String(reply.narration || '').slice(0, 220),
    };
    if (!plan.narration) plan.narration = 'Here is the finished result.';
    if (await tryShow(plan)) return plan;
    feedback = `Your last answer didn't work: the "show" element ${JSON.stringify(plan.show)} wasn't visible after the reveal actions. Look again.`;
  }
  log('check your work: skipped (could not find the result on screen)');
  return null;
}
