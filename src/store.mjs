// MongoDB storage. Video, thumbnail and caption files go into GridFS (Mongo's built-in way to
// store files larger than the 16 MB document limit, split into 255 KB chunks). Metadata goes
// into the `videos` collection; every render is kept in `video_versions`.
import { MongoClient, GridFSBucket } from 'mongodb';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

// Accept the common spellings, and say clearly which one (if any) is set. Values are never logged.
function mongoUri() {
  const names = ['MONGODB_URI', 'MONGO_URI', 'MONGODB_URL', 'MONGO_URL', 'DATABASE_URL'];
  const found = names.find((n) => process.env[n]?.trim());
  const related = Object.keys(process.env).filter((k) => /mongo|database/i.test(k));
  if (found) {
    console.log(`MongoDB: using ${found}`);
    return process.env[found].trim();
  }
  if (process.env.NODE_ENV === 'production') {
    console.error(`MongoDB: no connection string set. Add an environment variable named MONGODB_URI. Related variable names present: ${related.length ? related.join(', ') : 'none'}`);
    process.exit(1);
  }
  return 'mongodb://127.0.0.1:27017';
}

let client;
export async function getDb() {
  if (!client) client = await new MongoClient(mongoUri()).connect();
  return client.db(process.env.MONGODB_DB || 'docs_to_video');
}
export async function closeDb() { await client?.close(); client = undefined; }

export const bucket = (db) => new GridFSBucket(db, { bucketName: 'videofiles' });

export async function ensureIndexes(db) {
  await db.collection('videos').createIndex({ slug: 1 }, { unique: true });
  // Keyword search for local MongoDB. On Atlas, use Atlas Search + Vector Search ($rankFusion) instead.
  await db.collection('videos').createIndex(
    { title: 'text', description: 'text', answersQuestions: 'text', transcript: 'text' },
    { weights: { title: 5, answersQuestions: 4, description: 2, transcript: 1 }, name: 'video_text' },
  );
  await db.collection('jobs').createIndex({ status: 1, createdAt: 1 });
}

async function upload(db, filePath, filename, contentType, metadata) {
  const up = bucket(db).openUploadStream(filename, { metadata: { contentType, ...metadata } });
  await pipeline(fs.createReadStream(filePath), up);
  return up.id;
}

// What viewers see: share pages, the support agent's search and video links use the approved ("live")
// version. A new recording is a draft until it is approved (by a person, or automatically for re-records
// whose screens didn't change), so an unchecked video never replaces a good one.
const LIVE_FIELDS = ['version', 'title', 'description', 'answersQuestions', 'transcript', 'chapters', 'durationSec', 'narrated', 'voiceName', 'files', 'sizeBytes', 'storyboard', 'trimmedSec', 'qa'];
export const snapshot = (v) => Object.fromEntries(LIVE_FIELDS.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]));
// The version to show viewers: the live one, or (before anything was approved) the latest.
export const served = (v) => (v?.live ? { ...v, ...v.live, draftVersion: v.version } : v);

export async function approveVideo(db, slug, by = 'someone') {
  const v = await db.collection('videos').findOne({ slug });
  if (!v) return null;
  const now = new Date();
  await db.collection('videos').updateOne({ slug }, { $set: { live: { ...snapshot(v), approvedAt: now, approvedBy: by }, status: 'approved', approvedAt: now, approvedBy: by } });
  return v.version;
}

export async function downloadFile(db, id, filePath) {
  await pipeline(bucket(db).openDownloadStream(id), fs.createWriteStream(filePath));
  return filePath;
}

// approve: { by, reason } to make this version live straight away (auto-approval); otherwise it's a draft.
export async function saveVideo(db, { storyboard, composed, jobId, approve }) {
  const slug = storyboard.id;
  const meta = { slug };
  const files = {
    mp4: await upload(db, composed.mp4Path, `${slug}.mp4`, 'video/mp4', meta),
    thumbnail: await upload(db, composed.thumbPath, `${slug}.jpg`, 'image/jpeg', meta),
    captions: await upload(db, composed.vttPath, `${slug}.vtt`, 'text/vtt', meta),
    steps: [],
  };
  // One screenshot per step, for the written SOP.
  for (const [i, f] of (composed.stepFrames || []).entries()) files.steps.push(await upload(db, f, `${slug}-step-${i + 1}.jpg`, 'image/jpeg', meta));
  const sizeBytes = fs.statSync(composed.mp4Path).size;
  const now = new Date();
  const prev = await db.collection('videos').findOne({ slug });
  const version = (prev?.version || 0) + 1;
  // Videos approved before "live" versions existed: keep that approved version live while this one is a draft.
  const keepLive = prev && prev.status === 'approved' && !prev.live ? { live: { ...snapshot(prev), approvedAt: prev.approvedAt || now } } : {};

  await db.collection('video_versions').insertOne({
    slug, version, files, sizeBytes, storyboard, chapters: composed.chapters, jobId, createdAt: now,
  });
  await db.collection('videos').updateOne(
    { slug },
    {
      $set: {
        slug, title: storyboard.title, description: storyboard.description,
        answersQuestions: storyboard.answersQuestions, tags: storyboard.tags, guide: storyboard.guide,
        transcript: composed.transcript, chapters: composed.chapters, durationSec: composed.durationSec,
        narrated: composed.narrated, voiceName: composed.voiceName || null, files, sizeBytes, version, status: approve ? 'approved' : 'draft', updatedAt: now,
        storyboard, qa: composed.qa, trimmedSec: composed.trimmedSec, review: composed.review || null,
        ...keepLive,
        ...(approve ? { approvedAt: now, approvedBy: approve.by } : {}),
      },
      $unset: { needsAttention: '' },
      $setOnInsert: { createdAt: now, timesSent: 0 },
    },
    { upsert: true },
  );
  if (approve) {
    const v = await db.collection('videos').findOne({ slug });
    await db.collection('videos').updateOne({ slug }, { $set: { live: { ...snapshot(v), approvedAt: now, approvedBy: approve.by, reason: approve.reason } } });
  }
  return { slug, version, files, sizeBytes, approved: !!approve };
}

// Streams a stored file, with byte ranges so videos can seek.
export async function streamFile(db, req, res, fileId, cache = 'public, max-age=300') {
  const file = await db.collection('videofiles.files').findOne({ _id: fileId });
  if (!file) return res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'file not found' }));
  const type = file.metadata?.contentType || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), file.length - 1) : file.length - 1;
    if (start > end) return res.writeHead(416, { 'Content-Range': `bytes */${file.length}` }).end();
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${file.length}`, 'Cache-Control': cache });
    return bucket(db).openDownloadStream(fileId, { start, end: end + 1 }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': file.length, 'Cache-Control': cache });
  bucket(db).openDownloadStream(fileId).pipe(res);
}
