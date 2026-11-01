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
export async function perform(page, loc, step) {
  if (step.do === 'click') await loc.click();
  else if (step.do === 'fill' && step.value === '') await loc.fill('');
  else if (step.do === 'fill') { await loc.click(); await loc.fill(''); await loc.pressSequentially(step.value, { delay: 70 }); }
  else if (step.do === 'select') await loc.selectOption({ label: step.value });
  else if (step.do === 'press') await loc.press(step.key || 'Enter');
  else if (step.do === 'hover') await loc.hover();
  else throw new Error(`Unsupported step: ${step.do}`);
}

// Steps that don't act on one element.
export async function performPageStep(page, step) {
  if (step.do === 'pause') { await page.waitForTimeout(step.ms || 1000); return true; }
  // Wait for slow work in the app (e.g. Miter AI building a report) until some text shows it's finished.
  if (step.do === 'wait') {
    const ms = Math.min(Number(step.seconds) || 120, 600) * 1000;
    if (step.text) await page.getByText(step.text, { exact: false }).first().waitFor({ state: 'visible', timeout: ms });
    else await page.waitForTimeout(ms);
    await page.waitForTimeout(800);
    return true;
  }
  if (step.do === 'goto') { await page.goto(step.url, { waitUntil: 'domcontentloaded' }); return true; }
  if (step.do === 'scroll') { await page.mouse.wheel(0, step.dy || 500); await page.waitForTimeout(400); return true; }
  return false;
}
