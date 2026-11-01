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

export async function saveVideo(db, { storyboard, composed, jobId }) {
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
  const prev = await db.collection('videos').findOne({ slug }, { projection: { version: 1 } });
  const version = (prev?.version || 0) + 1;

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
        narrated: composed.narrated, files, sizeBytes, version, status: 'draft', updatedAt: now,
        storyboard, qa: composed.qa, trimmedSec: composed.trimmedSec,
      },
      $unset: { needsAttention: '' },
      $setOnInsert: { createdAt: now, timesSent: 0 },
    },
    { upsert: true },
  );
  return { slug, version, files, sizeBytes };
}
