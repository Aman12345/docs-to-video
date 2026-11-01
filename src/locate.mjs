// Shared by the recorder, the dry run and the prompt planner: turns a storyboard "target"
// into a Playwright locator, and performs one step. Keeping this in one place means a step
// that worked while planning works the same way while recording.

export function locate(page, t, label) {
  let loc;
  if (t.role) loc = page.getByRole(t.role, { name: t.name, exact: t.exact !== false });
  else if (t.testId) loc = page.getByTestId(t.testId);
  else if (t.label) loc = page.getByLabel(t.label, { exact: t.exact !== false });
  else if (t.placeholder) loc = page.getByPlaceholder(t.placeholder);
  else if (t.text) loc = page.getByText(t.text, { exact: !!t.exact });
  else throw new Error(`Unsupported target: ${JSON.stringify(t)}`);
  if (Number.isInteger(t.nth)) loc = loc.nth(t.nth);
  return loc.describe(label || t.name || t.label || t.placeholder || t.text || t.testId);
}

// Performs a step that has already been located. Returns nothing; throws on failure.
// timeout: how long Playwright keeps trying (default 30 s); the recorder uses less so a stuck step is noticed sooner.
export async function perform(page, loc, step, { timeout } = {}) {
  const o = timeout ? { timeout } : {};
  if (step.do === 'click') await loc.click(o);
  else if (step.do === 'fill' && step.value === '') await loc.fill('', o);
  else if (step.do === 'fill') { await loc.click(o); await loc.fill('', o); await loc.pressSequentially(step.value, { delay: 70, ...o }); }
  else if (step.do === 'select') await loc.selectOption({ label: step.value }, o);
  else if (step.do === 'press') await loc.press(step.key || 'Enter', o);
  else if (step.do === 'hover') await loc.hover(o);
  else throw new Error(`Unsupported step: ${step.do}`);
}

// Steps that don't act on one element.
export async function performPageStep(page, step, { waitSlack = 1 } = {}) {
  if (step.do === 'pause') { await page.waitForTimeout(step.ms || 1000); return true; }
  // Wait for slow work in the app (e.g. Miter AI building a report) until some text shows it's finished.
  if (step.do === 'wait') {
    if (!step.text && step.target?.text) step = { ...step, text: step.target.text }; // older plans kept the text here
    const ms = Math.min((Number(step.seconds) || 120) * waitSlack, 900) * 1000;
    if (!step.text) { await page.waitForTimeout(ms); return true; }
    // Only visible matches count (a hidden copy of the text elsewhere must not block the wait).
    const matches = page.getByText(step.text, { exact: false }).filter({ visible: true });
    if (step.gone) {
      // Wait until a busy label ("Working", "Building…") has disappeared.
      await matches.first().waitFor({ state: 'hidden', timeout: ms });
    } else {
      // Wait for a NEW occurrence: if the text is already on screen (e.g. an earlier "Worked for 2 min"
      // from Miter AI's planning), wait until one more appears, so we don't stop before the work is done.
      const before = await matches.count();
      if (before === 0) await matches.first().waitFor({ state: 'visible', timeout: ms });
      else {
        const t0 = Date.now();
        while ((await matches.count()) <= before) {
          if (Date.now() - t0 > ms) throw new Error(`Waited ${Math.round(ms / 1000)}s for another "${step.text}" to appear.`);
          await page.waitForTimeout(1000);
        }
      }
    }
    await page.waitForTimeout(800);
    return true;
  }
  if (step.do === 'goto') { await page.goto(step.url, { waitUntil: 'domcontentloaded' }); return true; }
  if (step.do === 'scroll') { await page.mouse.wheel(0, step.dy || 500); await page.waitForTimeout(400); return true; }
  return false;
}
