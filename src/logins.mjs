// Saved logins: a person logs in to an app (e.g. Miter staging) themselves, through a live view of the
// cloud browser in the dashboard. We then keep only the browser's logged-in session (cookies and local
// storage), encrypted in MongoDB, so every video for that app starts already signed in.
// No password is ever stored: the person types it into the site directly, and only the session is saved.
import crypto from 'node:crypto';
import { chromium } from 'playwright';
// Keep the browser alive when the server is asked to stop, so the worker decides what happens to the job.
const LAUNCH = { handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false };

export const VIEWPORT = { width: 1280, height: 720 };
const IDLE_MS = 10 * 60 * 1000;

// Sessions are as sensitive as a password, so they are encrypted with LOGIN_SECRET (or the demo password).
// New saves use the first secret that is set; unlocking also tries the others, so adding or changing
// DEMO_PASSWORD later doesn't lock out logins saved under LOGIN_SECRET or API_KEY (they are re-saved
// under the current secret the first time they are used).
const secrets = () => [process.env.LOGIN_SECRET, process.env.DEMO_PASSWORD, process.env.API_KEY].filter(Boolean);
const keyFor = (secret) => crypto.createHash('sha256').update(`docs-to-video-logins:${secret}`).digest();
function key() {
  const [secret] = secrets();
  if (!secret) throw new Error('Set LOGIN_SECRET (or DEMO_PASSWORD) on the service before saving logins.');
  return keyFor(secret);
}
const encrypt = (obj) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
};
const decryptWith = (k, e) => {
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(e.iv, 'base64'));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8'));
};
// Returns { value, current } where current is false if an older secret unlocked it.
const decrypt = (e) => {
  const all = secrets();
  for (const [i, s] of all.entries()) {
    try { return { value: decryptWith(keyFor(s), e), current: i === 0 }; } catch { /* try the next secret */ }
  }
  throw new Error('no secret unlocks this login');
};

export const cleanName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export async function listLogins(db) {
  return db.collection('logins').find({}, { projection: { secret: 0 } }).sort({ savedAt: -1 }).toArray();
}

// Returns { storageState, url } for recording, or throws a clear error.
export async function loadLogin(db, name) {
  const doc = await db.collection('logins').findOne({ name });
  if (!doc) throw new Error(`Saved login "${name}" was not found. Log in again from the dashboard.`);
  try {
    const { value, current } = decrypt(doc.secret);
    if (!current) await db.collection('logins').updateOne({ name }, { $set: { secret: encrypt(value) } });
    return { storageState: value, url: doc.url, name };
  } catch {
    throw new Error(`Saved login "${name}" could not be unlocked (LOGIN_SECRET changed?). Log in again from the dashboard.`);
  }
}

export const deleteLogin = (db, name) => db.collection('logins').deleteOne({ name });

// ---- Live login browsers (one per name, closed after 10 minutes idle) ----
const live = new Map();

function touch(s) {
  clearTimeout(s.timer);
  s.timer = setTimeout(() => closeLive(s.name), IDLE_MS);
}

export async function startLive(name, url) {
  await closeLive(name);
  const browser = await chromium.launch(LAUNCH);
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const s = { name, url, browser, context, page };
  live.set(name, s);
  touch(s);
  // Follow pop-ups (e.g. "Sign in with Google" windows) so the person can see and use them.
  context.on('page', (p) => { s.page = p; p.on('close', () => { if (s.page === p) s.page = context.pages().at(-1) || page; }); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  return s;
}

export function getLive(name) {
  const s = live.get(name);
  if (s) touch(s);
  return s;
}

export async function closeLive(name) {
  const s = live.get(name);
  if (!s) return;
  live.delete(name);
  clearTimeout(s.timer);
  await s.browser.close().catch(() => {});
}

export async function liveAction(name, a) {
  const s = getLive(name);
  if (!s) throw new Error('This login window has closed. Start again.');
  const p = s.page;
  if (a.type === 'click') await p.mouse.click(Number(a.x), Number(a.y));
  else if (a.type === 'type') await p.keyboard.type(String(a.text || ''), { delay: 15 });
  else if (a.type === 'key' && /^(Enter|Tab|Backspace|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(a.key)) await p.keyboard.press(a.key);
  else if (a.type === 'scroll') await p.mouse.wheel(0, Number(a.dy) || 0);
  else if (a.type === 'goto' && /^https?:\/\//i.test(a.url || '')) await p.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  else if (a.type === 'back') await p.goBack().catch(() => {});
  await p.waitForTimeout(250);
}

export async function liveShot(name) {
  const s = getLive(name);
  if (!s) return null;
  return { jpg: await s.page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null), url: s.page.url() };
}

// Save the logged-in session (not the password) and close the window.
export async function saveLive(db, name) {
  const s = getLive(name);
  if (!s) throw new Error('This login window has closed. Start again.');
  const storageState = await s.context.storageState();
  const landing = s.page.url();
  await db.collection('logins').updateOne(
    { name },
    { $set: { name, url: /^https?:/.test(landing) ? landing : s.url, origin: new URL(s.url).origin, secret: encrypt(storageState), cookies: storageState.cookies.length, savedAt: new Date() } },
    { upsert: true },
  );
  await closeLive(name);
}
