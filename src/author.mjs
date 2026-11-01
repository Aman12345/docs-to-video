// Prompt -> storyboard. Claude (through OpenRouter) drives a browser one step at a time:
// each turn it sees the page's accessibility tree (every button, link and field with its
// visible name) and picks the next action. Each action is performed for real, so the
// finished storyboard only contains steps that worked. Recording happens afterwards as a
// clean, deterministic replay of those steps.
import { chromium } from 'playwright';
// Keep the browser alive when the server is asked to stop, so the worker decides what happens to the job.
const LAUNCH = { handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false };
import { locate, perform, performPageStep } from './locate.mjs';

const MODEL = process.env.AUTHOR_MODEL || 'anthropic/claude-opus-5.5';
const MAX_ACTIONS = 22; // Miter AI flows need room: popups, navigation, form, chat, approve, waits
const MAX_ERRORS = 4;
const SNAPSHOT_CHARS = 14000;

const SYSTEM = `You operate a web browser to plan a short how-to video. You will be given a goal.
Each turn you see the current URL, page title, the actions taken so far, and an accessibility
snapshot of the page (YAML lines like: - button "Search", - link "Billing", - textbox "Email").

Reply with ONLY one JSON object describing the single next action:
{"do": "click" | "fill" | "select" | "press" | "goto" | "scroll" | "wait" | "done" | "fail",
 "target": {"role": "button", "name": "Search"},   // or {"label": ...}, {"placeholder": ...}, {"text": ...}
 "value": "text to type (fill) or option label (select)",
 "key": "Enter",          // for press
 "url": "https://...",    // for goto
 "text": "Worked for", "seconds": 300,   // for wait: text that appears only once the work is finished
 "why": "short reason",
 "narration": "one short, friendly sentence a narrator says to the viewer for this step"}

Rules:
- Copy roles and names exactly from the snapshot. Prefer {"role","name"}. If several elements share
  the same role and name, add "nth": 0 (or the right index).
- One action per reply. Keep the video short: reach the goal in as few actions as possible.
- Reply {"do":"done"} as soon as the goal is visibly achieved on screen.
- If the app is busy (a spinner, "Working", "Generating", "Building"), use "wait" with text that only appears
  once it has finished, and enough seconds (up to 600). Long waits are trimmed out of the final video.
- Reply {"do":"fail","why":"..."} if you are blocked: a CAPTCHA or "are you a robot" check, a login
  wall, or the site refuses. Never try to get around such checks.
- Never type passwords, payment details or personal information, and never place an order or
  complete a purchase. Adding an item to a cart is fine.
- For cookie or consent banners, choose reject / decline / necessary-only. Close unrelated popups.`;

// Extra rules when signed in to a company's own app (e.g. Miter staging) with a saved login.
const SIGNED_IN_RULES = `

You are signed in to a company's own business app with a test account. Be careful:
- Never do anything that cannot be undone or that reaches other people: do not run, submit or approve
  payroll, payments or timesheets; do not send, invite, email, message, publish, delete, archive or
  void anything; do not change settings, permissions, bank details or integrations.
- You may open screens, menus and forms and fill in fields with obviously fake example data
  (e.g. "Jane Example") to show how something works. Stop before the final Save / Submit / Send /
  Confirm button unless the goal explicitly asks to create a test record; the narration can still
  tell the viewer to click it.
- If you see a sign-in or login page, reply {"do":"fail","why":"The saved login has expired - log in again from the dashboard."}.`;

function parseJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error(`No JSON in model reply: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(s, e + 1));
}

async function chat(messages, usage, maxTokens = 900) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set, so Claude cannot plan the video.');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'docs-to-video' },
    body: JSON.stringify({
      model: MODEL, messages, max_tokens: maxTokens, temperature: 0,
      provider: { order: ['anthropic'], allow_fallbacks: true },
      usage: { include: true },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  usage.calls += 1;
  usage.costUsd += Number(data.usage?.cost || 0);
  usage.inputTokens += data.usage?.prompt_tokens || 0;
  usage.outputTokens += data.usage?.completion_tokens || 0;
  return data.choices?.[0]?.message?.content || '';
}

async function snapshot(page) {
  let snap = '';
  try { snap = await page.locator('body').ariaSnapshot({ timeout: 8000 }); } catch (e) { snap = `(snapshot failed: ${e.message.split('\n')[0]})`; }
  snap = snap.split('\n').filter((l) => !l.trim().startsWith('- /url:')).join('\n');
  return snap.length > SNAPSHOT_CHARS ? `${snap.slice(0, SNAPSHOT_CHARS)}\n... (truncated)` : snap;
}

const describe = (a) => `${a.do} ${a.target ? JSON.stringify(a.target) : a.url || a.key || (a.text ? `until "${a.text}" (${a.seconds || 120}s max)` : '')}${a.value ? ` value="${a.value}"` : ''}`;

const slugify = (s) => String(s || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'video';

export async function authorStoryboard({ prompt, startUrl, baseUrl, storageState, log = console.log }) {
  const start = new URL(startUrl || '/', baseUrl).toString();
  const usage = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, model: MODEL };
  const actions = [];
  const history = [];
  let errors = 0;

  const browser = await chromium.launch(LAUNCH);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...(storageState ? { storageState } : {}) });
  const page = await context.newPage();
  const system = SYSTEM + (storageState ? SIGNED_IN_RULES : '');
  try {
    await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);

    while (actions.length < MAX_ACTIONS) {
      const user = [
        `Goal: ${prompt}`,
        `Current URL: ${page.url()}`,
        `Page title: ${await page.title().catch(() => '')}`,
        `Actions so far:\n${history.length ? history.map((h, i) => `${i + 1}. ${h}`).join('\n') : '(none yet)'}`,
        `Accessibility snapshot:\n${await snapshot(page)}`,
      ].join('\n\n');
      const reply = parseJson(await chat([{ role: 'system', content: system }, { role: 'user', content: user }], usage));

      if (reply.do === 'done') { log(`plan: done after ${actions.length} actions`); break; }
      if (reply.do === 'fail') throw new Error(`Claude stopped: ${reply.why || 'blocked'}`);

      const step = { do: reply.do, target: reply.target, value: reply.value, key: reply.key, url: reply.url, text: reply.text, seconds: reply.seconds, narration: reply.narration };
      // Claude sometimes puts the wait text in "target"; treat it as the text to wait for.
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
        log(`plan: ${describe(step)}`);
      } catch (e) {
        errors += 1;
        history.push(`${describe(step)} -> FAILED: ${e.message.split('\n')[0].slice(0, 200)}`);
        log(`plan: failed ${describe(step)} (${errors}/${MAX_ERRORS})`);
        if (errors >= MAX_ERRORS) throw new Error(`Could not complete the steps: ${e.message.split('\n')[0]}`);
      }
    }
    if (!actions.length) throw new Error('Claude did not find any steps to perform.');
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
    { role: 'user', content: `Goal of the video: ${prompt}\n\nThese browser actions were performed, in order:\n${list}\n\nGroup them into 2 to 5 scenes, in order, using every action index exactly once. Return:\n{"title": "short task-style title", "description": "one sentence", "answersQuestions": ["3 ways a user might ask for this"], "intro": "spoken opening, max 25 words: what the viewer will learn and the steps in order", "outro": "spoken closing, max 25 words: recap of what they did and the result", "checks": ["2-3 short things the viewer can check to confirm it worked"], "scenes": [{"chapter": "2-4 word step title", "narration": "one or two short sentences, max 25 words, speaking to the viewer", "steps": [0, 1]}]}` },
  ], usage, 1500));

  const used = new Set();
  let scenes = (outline.scenes || []).map((s) => ({
    chapter: s.chapter,
    narration: s.narration,
    steps: (s.steps || []).filter((i) => Number.isInteger(i) && actions[i] && !used.has(i) && used.add(i)).map((i) => toStep(actions[i])),
  })).filter((s) => s.steps.length);
  if (used.size !== actions.length) {
    // Fallback: one scene per action, using Claude's narration ideas.
    scenes = actions.map((a, i) => ({ chapter: `Step ${i + 1}`, narration: a.narration || describe(a), steps: [toStep(a)] }));
  }
  scenes.at(-1).steps.push({ do: 'pause', ms: 1500 });

  const storyboard = {
    id: slugify(outline.title || prompt),
    title: outline.title || prompt,
    description: outline.description || prompt,
    answersQuestions: outline.answersQuestions || [],
    intro: typeof outline.intro === 'string' ? outline.intro : undefined,
    outro: typeof outline.outro === 'string' ? outline.outro : undefined,
    checks: Array.isArray(outline.checks) ? outline.checks.slice(0, 4).map(String) : undefined,
    tags: { source: 'prompt' },
    prompt,
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
  if (a.do === 'wait') { if (a.text) s.text = String(a.text); s.seconds = Math.min(Number(a.seconds) || 120, 600); }
  if (['click', 'fill', 'select', 'press'].includes(a.do)) s.zoom = a.do !== 'press';
  return s;
}
