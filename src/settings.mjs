// Settings changed from the dashboard's Settings page. Saved in MongoDB (settings collection), so they
// survive restarts and need no redeploy. Anything left empty falls back to the Render environment
// variable, then to the built-in default.
export const SETTINGS = {
  authorModel: { env: 'AUTHOR_MODEL', default: 'anthropic/claude-opus-5.5' },
  repairModel: { env: 'REPAIR_MODEL', default: '' }, // empty: same as authorModel
  repair: { env: 'REPAIR', default: 'on' }, // on / off
  repairMaxTurns: { env: 'REPAIR_MAX_TURNS', default: '4' },
  reasoningEffort: { env: 'AI_REASONING_EFFORT', default: 'low' }, // for OpenAI GPT models
  voice: { env: '', default: '' }, // default voice id (src/voices.mjs); empty: TTS_MODEL / TTS_VOICE
  checkStep: { env: 'CHECK_STEP', default: 'on' }, // end each video by showing the result
  recordOn: { env: 'RECORD_ON', default: 'render' }, // render / github / cloudrun: which workers take new jobs (src/runners.mjs)
};

let saved = {};

export async function loadSettings(db) {
  const doc = await db.collection('settings').findOne({ _id: 'app' }).catch(() => null);
  saved = doc?.values || {};
  return saved;
}

export async function saveSettings(db, values) {
  const clean = {};
  for (const k of Object.keys(SETTINGS)) {
    const v = String(values[k] ?? '').trim();
    if (v) clean[k] = v.slice(0, 120);
  }
  await db.collection('settings').updateOne({ _id: 'app' }, { $set: { values: clean, updatedAt: new Date() } }, { upsert: true });
  saved = clean;
}

// The value in use, and where it came from ('settings' | 'render' | 'default').
export function setting(key) {
  const s = SETTINGS[key];
  if (saved[key]) return { value: saved[key], from: 'settings' };
  if (s.env && process.env[s.env]) return { value: process.env[s.env], from: 'render' };
  return { value: s.default, from: 'default' };
}
export const get = (key) => setting(key).value;

// New jobs go to the workers chosen on the Settings page. Workers only take jobs from their own pool
// (WORKER_POOL on the worker; Render's worker has none), so a Cloud Run test never collides with Render.
export const poolForNewJob = () => (['github', 'cloudrun'].includes(get('recordOn')) ? { pool: get('recordOn') } : {});
