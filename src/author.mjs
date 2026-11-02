// Prompt -> storyboard. The AI (any model, through OpenRouter) drives a browser one step at a time:
// each turn it sees the page's accessibility tree (every button, link and field with its
// visible name) and picks the next action. Each action is performed for real, so the
// finished storyboard only contains steps that worked. Recording happens afterwards as a
// clean, deterministic replay of those steps.
import { chromium } from 'playwright';
// Keep the browser alive when the server is asked to stop, so the worker decides what happens to the job.
const LAUNCH = { handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false };
import { locate, perform, performPageStep } from './locate.mjs';
import { planCheck, CHECK_CHAPTER } from './check.mjs';
import { get, guidelinesText } from './settings.mjs';
import { authorModel, repairModel, chat, parseJson, snapshot, describe, newUsage } from './ai.mjs';

const MAX_ACTIONS = 22; // Miter AI flows need room: popups, navigation, form, chat, approve, waits
const MAX_ERRORS = 4;

const SYSTEM = `You operate a web browser to plan a short how-to video. You will be given a goal.
Each turn you see the current URL, page title, the actions taken so far, and an accessibility
snapshot of the page (YAML lines like: - button "Search", - link "Billing", - textbox "Email").

Reply with ONLY one JSON object describing the single next action:
{"do": "click" | "fill" | "select" | "press" | "goto" | "scroll" | "wait" | "done" | "fail",
 "target": {"role": "button", "name": "Search"},   // or {"label": ...}, {"placeholder": ...}, {"text": ...}
 "value": "text to type (fill) or option label (select)",
 "key": "Enter",          // for press
 "url": "https://...",    // for goto
 "text": "Worked for", "seconds": 300,   // for wait: text that appears once the work is finished
 "gone": true,            // optional, for wait: wait until "text" (e.g. "Working") DISAPPEARS instead
 "why": "short reason",
 "narration": "one short spoken sentence for this step: where, then the action, using the exact label"}

Rules:
- Copy roles and names exactly from the snapshot. Prefer {"role","name"}. If several elements share
  the same role and name, add "nth": 0 (or the right index).
- One action per reply. Keep the video short: reach the goal in as few actions as possible.
- Reply {"do":"done"} as soon as the goal is visibly achieved on screen. If your actions created records (a report,
  an expense, a policy), add "created": "what was created and its name", e.g. {"do":"done","created":"a report named Earnings - video test"}.
- If the goal needs data that doesn't exist yet (e.g. a submitted, signed report to approve, an expense waiting
  for review), don't stop: reply {"do":"setup","why":"exactly what test data is needed"} and it will be prepared
  off-camera before the video is recorded.
- If the app is busy (a spinner, "Working", "Generating", "Building"), use "wait": either the busy label with
  "gone": true (waits until it disappears), or text that appears only once it has finished. If that text is
  already on screen from earlier, the wait waits for a NEW occurrence. Allow enough seconds (up to 600).
  Long waits are trimmed out of the final video. Only reply "done" once the final result is visible.
- Reply {"do":"fail","why":"..."} if you are blocked: a CAPTCHA or "are you a robot" check, a login
  wall, or the site refuses. Never try to get around such checks.
- Never type passwords, payment details or personal information, and never place an order or
  complete a purchase. Adding an item to a cart is fine.
- For cookie or consent banners, choose reject / decline / necessary-only. Close unrelated popups.
- Show choices, don't hide them: when the viewer has to pick from several options (a dropdown, radio buttons,
  an approver type, a policy rule), open the list so the options are visible, then {"do":"wait","seconds":2} so
  viewers can read them, and use that step's "narration" to name the main options and when each is used, in
  one or two short sentences. Then pick the option this example needs. Never pick one silently as if it were
  the only choice.
- When the goal is to set something up (a policy, a rule, an approval flow), show the settings that matter,
  not only the minimum needed to save.`;

// How to write the spoken script. Drawn from instructional-video and UI-writing guidance: TechSmith's
// video-length research (one focused task, short opening), Mayer's multimedia principles (signal what
// matters, segment, don't read the screen aloud, conversational "you"), tight screen-recording scripts
// (short spoken sentences, verb first, exact values), and the Microsoft / Google style guides for UI
// instructions (location first, exact label, "select" / "enter" / "turn on", no element-type words).
export const SCRIPT_RULES = `How to write the narration (it is spoken by a voice and shown as captions):
- Sound like a calm, friendly product trainer talking to one person. Use "you", present tense, active voice.
  No hype, filler or jokes, and never "simply", "just", "go ahead and", "let's", "now I'll", "as you can see".
- One idea per sentence; keep sentences under about 15 words. Each step's narration: 1-2 sentences, max 25 words.
- Say where, then what, using the exact on-screen label: "In Spend, open Reimbursements." "Select Create."
  Verbs: "select" for buttons, tabs, links, menu items and list options; "enter" for typing a value;
  "choose" for picking from a list; "turn on" / "turn off" for toggles; "go to" for navigation.
  Don't name the element type (button, tab, dropdown) unless it is needed to find it.
- Speak exact values: "Enter 42.50 as the amount." Use realistic example data naturally; don't call it fake.
- This is a training video: viewers will repeat it with their own details. When a value is the viewer's own
  choice (where they're going, dates, which employee, job or project, an amount, a name), say it's theirs and
  that ours is an example: "Enter where you're going. For this example, Paris." "Choose the employee; here,
  Jane Example." Never present an example value as the one everyone must use. Fixed values (a required
  setting, the only option that works) are said plainly.
- Add at most one short reason when it helps: "so the expense is costed to the right job."
- Don't read every word on the screen; name only what the viewer needs to act on, and what they should see next.
- Step titles (chapters): 2-4 words, verb first, sentence case: "Open Reimbursements", "Enter the amount".
- Intro: max 20 words. Say the outcome, then "It takes N quick steps." Add a prerequisite only if one is
  really needed ("You'll need admin access."). Don't list the steps; they are shown on screen.`;

// Extra rules when signed in to a company's own app (e.g. Miter staging) with a saved login.
export const SIGNED_IN_RULES = `

You are signed in to a company's own business app with a test account. Be careful:
- Never do anything that cannot be undone or that reaches other people: do not run, submit or approve
  payroll, payments or timesheets; do not send, invite, email, message, publish, delete, archive or
  void anything; do not change settings, permissions, bank details or integrations.
- You may open screens, menus and forms and fill in fields with obviously fake example data
  (e.g. "Jane Example") to show how something works. Stop before the final Save / Submit / Send /
  Confirm button unless the goal explicitly asks to create a test record; the narration can still
  tell the viewer to click it.
- If you see a sign-in or login page, reply {"do":"fail","why":"The saved login has expired - log in again from the dashboard."}.`;

// Off-camera helpers. Setup prepares the test data a video needs before it's recorded; cleanup removes what the
// video created afterwards. Both are saved with the video and replayed on every re-record (not shown in it).
const AGENT_FORMAT = `Each turn you see the current URL, page title, the actions taken so far, and an accessibility snapshot
of the page (YAML lines like: - button "Save", - textbox "Name"). Reply with ONLY one JSON object, the single next action:
{"do": "click" | "fill" | "select" | "press" | "goto" | "scroll" | "wait" | "done" | "fail",
 "target": {"role": "button", "name": "Save"},   // or {"label": ...}, {"placeholder": ...}, {"text": ...}; add "nth" if several match
 "value": "...", "key": "Enter", "url": "https://...", "text": "...", "seconds": 5, "why": "short reason"}
Copy roles and names exactly from the snapshot. One action per reply.`;
const SETUP_SYSTEM = `You prepare test data in a company's staging app (signed in with a test account) so that a how-to video
can be recorded afterwards. Nobody sees these steps; work quickly and directly.
${AGENT_FORMAT}
Rules:
- You may create, fill in, save, sign and submit test records using obviously fake example data (e.g. "Jane Example").
  Put "video test" in any name, title, description or memo field so the record can be found and cleaned up later.
- Never run or approve payroll or payments, never send emails, messages or invites, never change company settings,
  permissions, bank details or integrations, and never delete anything.
- Reply {"do":"done"} once the data is ready. Reply {"do":"fail","why":"..."} if it can't be done with this account
  (e.g. it needs another person's login).`;
const CLEANUP_SYSTEM = `You clean up after a how-to video was recorded in a company's staging app (test account). Nobody sees these steps.
${AGENT_FORMAT}
Rules:
- Delete, archive or void ONLY the test records listed in the goal (they have "video test" in a name or memo, or were
  just created with example data). Confirm the deletion dialog for those records only.
- Never touch anything else, never change settings, never send anything.
- Reply {"do":"done"} when finished, or straight away if you can't find them or aren't sure (leaving them is safe).`;

const slugify = (s) => String(s || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'video';

// One browser agent loop: the AI picks one action at a time until it replies done / fail / setup.
async function runAgent(page, { goal, system, model, usage, log, label = 'plan', max = MAX_ACTIONS, note = '' }) {
  const actions = [];
  const history = [];
  let errors = 0;
  while (actions.length < max) {
    const user = [
      `Goal: ${goal}`, note,
      `Current URL: ${page.url()}`,
      `Page title: ${await page.title().catch(() => '')}`,
      `Actions so far:\n${history.length ? history.map((h, i) => `${i + 1}. ${h}`).join('\n') : '(none yet)'}`,
      `Accessibility snapshot:\n${await snapshot(page)}`,
    ].filter(Boolean).join('\n\n');
    const reply = parseJson(await chat([{ role: 'system', content: system }, { role: 'user', content: user }], usage, { model }));
    if (['done', 'fail', 'setup'].includes(reply.do)) { log(`${label}: ${reply.do}${reply.why ? ` (${reply.why})` : ''} after ${actions.length} actions`); return { actions, end: reply }; }

    const step = { do: reply.do, target: reply.target, value: reply.value, key: reply.key, url: reply.url, text: reply.text, seconds: reply.seconds, gone: reply.gone === true, narration: reply.narration };
    // The AI sometimes puts the wait text in "target"; treat it as the text to wait for.
    if (step.do === 'wait' && !step.text && step.target?.text) { step.text = step.target.text; delete step.target; }
    if (step.do === 'wait') delete step.target;
    try {
      if (!(await performPageStep(page, step))) {
        if (!step.target) throw new Error('No target given for this action.');
        const loc = locate(page, step.target);
        await loc.waitFor({ state: 'visible', timeout: 8000 });
        await perform(page, loc, step);
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1000);
      actions.push(step);
      history.push(`${describe(step)} -> ok`);
      errors = 0;
      log(`${label}: ${describe(step)}`);
    } catch (e) {
      errors += 1;
      history.push(`${describe(step)} -> FAILED: ${e.message.split('\n')[0].slice(0, 200)}`);
      log(`${label}: failed ${describe(step)} (${errors}/${MAX_ERRORS})`);
      if (errors >= MAX_ERRORS) throw new Error(`Could not complete the ${label === 'plan' ? '' : `${label} `}steps: ${e.message.split('\n')[0]}`);
    }
  }
  return { actions, end: { do: 'done', why: 'step limit reached' } };
}

// Long requests (e.g. a pasted help article) are condensed once into a short goal plus key facts. The planner
// sends the request with every step, so a 5,000-character article would otherwise be paid for dozens of times.
async function condense(prompt, usage, log) {
  const text = String(prompt).replace(/<[^>]+>/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= 1200) return text;
  const r = parseJson(await chat([
    { role: 'system', content: 'You turn a long request for a how-to video into a short brief. Reply with ONLY one JSON object.' },
    { role: 'user', content: `Request (may include a pasted help article):\n<<<${text.slice(0, 20000)}>>>\n\nReply: {"goal": "one sentence: what the video should show", "facts": ["up to 8 short facts from the text the video needs: where things are, labels, options, rules"]}` },
  ], usage, { model: repairModel(), maxTokens: 700 }));
  const brief = `${r.goal || text.slice(0, 300)}${Array.isArray(r.facts) && r.facts.length ? `\nKey facts:\n${r.facts.slice(0, 8).map((f) => `- ${f}`).join('\n')}` : ''}`;
  log(`plan: condensed a ${text.length}-character request into a short brief`);
  return brief;
}

export async function authorStoryboard({ prompt: fullPrompt, startUrl, baseUrl, storageState, log = console.log }) {
  const start = new URL(startUrl || '/', baseUrl).toString();
  const model = authorModel();
  const usage = newUsage(model);
  const prompt = await condense(fullPrompt, usage, log);
  // Setup and cleanup are mechanical: the cheaper takeover model does them.
  const helper = repairModel();
  let actions = [];
  let checkPlan = null;
  let setup = [], cleanup = [], setupWhy = '';

  const browser = await chromium.launch(LAUNCH);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...(storageState ? { storageState } : {}) });
  const page = await context.newPage();
  const system = SYSTEM + (storageState ? SIGNED_IN_RULES : '') + guidelinesText();
  try {
    await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);

    let run = await runAgent(page, { goal: prompt, system, model, usage, log });
    // Missing data (e.g. no submitted report to approve): prepare it off-camera, then plan the video again.
    if (run.end.do === 'setup') {
      if (!storageState) throw new Error(`The AI stopped: it needs test data first (${run.end.why}), which is only prepared in signed-in apps.`);
      setupWhy = String(run.end.why || 'test data').slice(0, 300);
      log(`plan: preparing test data off-camera first: ${setupWhy}`);
      const prep = await runAgent(page, { goal: `Prepare this test data: ${setupWhy}. (The video will then show: ${prompt.split('\n')[0]})`, system: SETUP_SYSTEM, model: helper, usage, log, label: 'setup', max: 25 });
      if (prep.end.do !== 'done') throw new Error(`The AI stopped: it couldn't prepare the test data this video needs (${prep.end.why || setupWhy}).`);
      setup = prep.actions;
      await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1200);
      run = await runAgent(page, { goal: prompt, system, model, usage, log, note: `Test data was just prepared for this video: ${setupWhy}. Use it; don't ask for setup again.` });
      if (run.end.do === 'setup') throw new Error(`The AI stopped: it still can't find the test data it needs (${run.end.why}).`);
    }
    if (run.end.do === 'fail') throw new Error(`The AI stopped: ${run.end.why || 'blocked'}`);
    actions = run.actions;
    if (!actions.length) throw new Error('The AI did not find any steps to perform.');
    // The ending: show the finished result ("Check your work"), planned on this final screen.
    if (get('checkStep') !== 'off') {
      checkPlan = await planCheck(page, { storyboard: { title: prompt, prompt, scenes: [{ steps: actions }] }, usage, log,
        tryShow: async (pl) => locate(page, pl.show).waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false) }).catch((e) => { log(`check your work: skipped (${e.message.split('\n')[0]})`); return null; });
    }
    // Cleanup: remove what the setup and the video created, so staging doesn't fill up with test records.
    const created = [setupWhy && `the test data prepared for the video (${setupWhy})`, run.end.created].filter(Boolean).join('; ');
    if (storageState && created) {
      try {
        const done = await runAgent(page, { goal: `Delete or archive these test records: ${created}.`, system: CLEANUP_SYSTEM, model: helper, usage, log, label: 'cleanup', max: 15 });
        cleanup = done.end.do === 'done' ? done.actions : [];
      } catch (e) { log(`cleanup: skipped (${e.message.split('\n')[0]})`); }
    }
  } catch (e) {
    e.screenshot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
    throw e;
  } finally {
    await browser.close();
  }

  // Second pass: group the working actions into a few titled scenes with narration.
  const list = actions.map((a, i) => `${i}. ${describe(a)} | narration idea: ${a.narration || ''}`).join('\n');
  const outline = parseJson(await chat([
    { role: 'system', content: 'You write short how-to video storyboards. Reply with ONLY one JSON object.' },
    { role: 'user', content: `Goal of the video: ${prompt}\n\nThese browser actions were performed, in order:\n${list}\n\n${SCRIPT_RULES}\n\nGroup them into 2 to 5 scenes (steps), in order, using every action index exactly once.${guidelinesText()} Return:\n{"title": "short task-style title in sentence case, starting with a verb, e.g. Create a reimbursement (capitalise only names and product terms)", "description": "one sentence", "answersQuestions": ["3 ways a user might ask for this"], "intro": "spoken opening, max 20 words, following the intro rule", "checks": ["2-3 short things the viewer can check to confirm it worked"], "scenes": [{"chapter": "2-4 word step title", "narration": "1-2 short spoken sentences, max 25 words, following the narration rules", "steps": [0, 1]}]}` },
  ], usage, { model, maxTokens: 1500 }));

  const used = new Set();
  let scenes = (outline.scenes || []).map((s) => ({
    chapter: s.chapter,
    narration: s.narration,
    steps: (s.steps || []).filter((i) => Number.isInteger(i) && actions[i] && !used.has(i) && used.add(i)).map((i) => toStep(actions[i])),
  })).filter((s) => s.steps.length);
  if (used.size !== actions.length) {
    // Fallback: one scene per action, using the AI's narration ideas.
    scenes = actions.map((a, i) => ({ chapter: `Step ${i + 1}`, narration: a.narration || describe(a), steps: [toStep(a)] }));
  }
  scenes.at(-1).steps.push({ do: 'pause', ms: 1500 });
  if (checkPlan) scenes.push({ chapter: checkPlan.chapter || CHECK_CHAPTER, narration: checkPlan.narration, check: true,
    steps: [...checkPlan.reveal.map((a) => ({ ...a, optional: true })), { do: 'show', target: checkPlan.show }, { do: 'pause', ms: 1500 }] });

  const storyboard = {
    id: slugify(outline.title || prompt.split('\n')[0]),
    title: outline.title || prompt.split('\n')[0].slice(0, 100),
    description: outline.description || prompt.split('\n')[0].slice(0, 200),
    answersQuestions: outline.answersQuestions || [],
    intro: typeof outline.intro === 'string' ? outline.intro : undefined,
    outro: typeof outline.outro === 'string' ? outline.outro : undefined,
    checks: Array.isArray(outline.checks) ? outline.checks.slice(0, 4).map(String) : undefined,
    tags: { source: 'prompt' },
    ...(setup.length ? { setup: setup.map(toStep).map(({ zoom, ...st }) => st), setupWhy } : {}),
    ...(cleanup.length ? { cleanup: cleanup.map(toStep).map(({ zoom, ...st }) => st) } : {}),
    prompt: String(fullPrompt).length > 1200 ? prompt : fullPrompt,
    startUrl: startUrl || '/',
    scenes,
  };
  log(`plan: ${scenes.length} scenes, ${actions.length} actions, ${usage.calls} model calls, $${usage.costUsd.toFixed(3)}`);
  return { storyboard, usage };
}

function toStep(a) {
  const s = { do: a.do };
  if (a.target) s.target = a.target;
  if (a.value !== undefined && a.value !== null) s.value = String(a.value);
  if (a.key) s.key = a.key;
  if (a.url) s.url = a.url;
  if (a.do === 'wait') { if (a.text) s.text = String(a.text); s.seconds = Math.min(Number(a.seconds) || 120, 600); if (a.gone) s.gone = true; }
  if (['click', 'fill', 'select', 'press'].includes(a.do)) s.zoom = a.do !== 'press';
  return s;
}
