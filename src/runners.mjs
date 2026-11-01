// Where videos are recorded. The Settings page picks one for new jobs:
//   render  — the Render server itself (one video at a time on its CPU)
//   github  — GitHub Actions: a fresh 4-CPU machine per video, free for public repos (.github/workflows/record.yml)
//   cloudrun — Google Cloud Run jobs (cloudrun/), started from Cloud Shell
// Each worker only takes jobs from its own pool (WORKER_POOL), so two places never record the same job.
// For GitHub, the dashboard starts machines through GitHub's API (GITHUB_DISPATCH_TOKEN on Render).
export const RUNNERS = {
  render: { label: 'Render (this server)', short: 'Render' },
  github: { label: 'GitHub Actions (free, 4 CPUs per video)', short: 'GitHub' },
  cloudrun: { label: 'Google Cloud Run (test)', short: 'Google Cloud Run' },
};

const REPO = process.env.GITHUB_REPO || 'Aman12345/docs-to-video';
const MAX_PARALLEL = 20; // GitHub's free plan runs about 20 jobs at once
export const githubReady = () => !!process.env.GITHUB_DISPATCH_TOKEN;

// Starts one GitHub machine per waiting GitHub job that doesn't have one yet. Safe to call any time.
// Returns { started, error }.
export async function kickRunners(db) {
  const jobs = db.collection('jobs');
  const waiting = await jobs.find({ status: 'queued', pool: 'github', dispatchedAt: { $exists: false } }, { projection: { _id: 1 } }).toArray();
  if (!waiting.length) return { started: 0 };
  if (!githubReady()) {
    await jobs.updateMany({ _id: { $in: waiting.map((j) => j._id) } }, { $set: { lastEvent: 'Waiting: GITHUB_DISPATCH_TOKEN is not set on Render, so GitHub machines can\'t be started.' } });
    return { started: 0, error: 'GITHUB_DISPATCH_TOKEN is not set on Render.' };
  }
  const n = Math.min(waiting.length, MAX_PARALLEL);
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/record.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GITHUB_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'docs-to-video' },
    body: JSON.stringify({ ref: process.env.GITHUB_REF_NAME || 'main', inputs: { machines: String(n) } }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
  if (!res.ok) {
    const error = `GitHub didn't start the machines (${res.status}): ${(await res.text()).slice(0, 200)}`;
    await jobs.updateMany({ _id: { $in: waiting.map((j) => j._id) } }, { $set: { lastEvent: error } });
    return { started: 0, error };
  }
  const ids = waiting.slice(0, n).map((j) => j._id);
  await jobs.updateMany({ _id: { $in: ids } }, {
    $set: { dispatchedAt: new Date(), lastEvent: 'Starting a GitHub machine (usually within a minute)' },
    $push: { events: { $each: [{ at: new Date(), msg: 'Asked GitHub Actions for a machine to record this video.' }], $slice: -300 } },
  });
  return { started: n };
}
