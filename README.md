# docs-to-video (proof of concept)

Turns a storyboard (narration + steps) into a polished how-to video with Playwright and ffmpeg,
stores it in MongoDB, and serves it through one API. Built to run on Render.

## What runs where

| Piece | File | Render service |
| --- | --- | --- |
| API: job intake, search, video streaming, share pages | `src/api.mjs` | `video-api` (web service) |
| Worker: claims jobs, records, composes, stores | `src/worker.mjs` | `video-worker` (background worker) |
| Recorder: replays the storyboard in headless Chromium | `src/record.mjs`, `src/cursor.js` | inside the worker |
| Composer: zoom, caption band, narration, MP4, thumbnail | `src/compose.mjs` | inside the worker |
| Storage: GridFS files + `videos`, `video_versions`, `jobs` | `src/store.mjs` | MongoDB Atlas |

Both services use the same Docker image (`Dockerfile`, based on Microsoft's Playwright 1.63 image
plus ffmpeg). `render.yaml` is a Render Blueprint for both services and their shared settings.

## Demo on Render (one service)

1. Push this folder to a GitHub repo.
2. In MongoDB Atlas: Network Access, allow `0.0.0.0/0` for the demo (or Render's outbound IPs), and copy the connection string.
3. In Render: New, Web Service, pick the repo, runtime **Docker**, instance **Standard** (1 CPU, 2 GB).
4. Environment variables: `MONGODB_URI` (from Atlas), `DEMO_PASSWORD` (any password), optional `OPENROUTER_API_KEY` for narration, optional `APP_URL` to film a different app.
5. Open the service URL, log in with any username and `DEMO_PASSWORD`, pick a storyboard and click **Make video** (about 1–2 minutes).

The default start command (`node src/server.mjs`) runs the page, API, worker and the sample app in one process.
For production, use `render.yaml`: separate `video-api` and `video-worker` services.

## Run it locally

```bash
docker run -d --name mongo -p 27017:27017 mongo:8.0
npm install
node src/pipeline.mjs storyboards/export-invoices.json   # one video, straight into MongoDB
node src/api.mjs &                                        # http://127.0.0.1:10000
node src/worker.mjs                                       # processes queued jobs
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/jobs` | Queue a video: `{ "storyboard": {...} }` (Bearer `API_KEY`) |
| GET | `/jobs/:id` | Job status: queued, running, done, failed |
| GET | `/search?q=...&status=approved` | Find videos (support agent's `search_videos`) |
| POST | `/videos/:slug/approve` | Mark a draft as approved |
| GET | `/videos/:slug` | Video metadata |
| GET | `/videos/:slug/video` | The MP4, streamed from GridFS with Range support |
| GET | `/videos/:slug/thumbnail`, `/captions` | Thumbnail JPEG, WebVTT captions |
| GET | `/v/:slug` | Share page for clients: player, captions, step list |

## Settings

`MONGODB_URI`, `MONGODB_DB`, `APP_URL` (the resettable app copy; empty = bundled demo app),
`PUBLIC_URL`, `API_KEY`, `OPENROUTER_API_KEY` (turns on narration via OpenRouter TTS).

## Not in this proof yet

The Claude authoring agent (guide + code to storyboard), the Slack bot, Atlas Search/Vector Search
(local MongoDB uses a text index instead), and re-rendering on GitHub merges.
