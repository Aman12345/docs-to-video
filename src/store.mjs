// MongoDB storage. Video, thumbnail and caption files go into GridFS (Mongo's built-in way to
// store files larger than the 16 MB document limit, split into 255 KB chunks). Metadata goes
// into the `videos` collection; every render is kept in `video_versions`.
import { MongoClient, GridFSBucket } from 'mongodb';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

let client;
export async function getDb() {
  if (!client) client = await new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017').connect();
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
  };
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
      },
      $setOnInsert: { createdAt: now, timesSent: 0 },
    },
    { upsert: true },
  );
  return { slug, version, files, sizeBytes };
}
