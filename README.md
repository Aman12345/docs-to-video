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
5. Open the service URL, log in with `DEMO_USER` (any username if unset) and `DEMO_PASSWORD`, pick a storyboard and click **Make video** (about 1–2 minutes).

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

## Branding and voiceover

Every video gets a branded intro card, a title card at the start of each chapter, a "Step 2/4" label,
the logo in the caption band, a closing card, and chapter markers in the MP4. All set by environment variables:

| Variable | What it does | Default |
|---|---|---|
| `BRAND_NAME` | Name shown when there is no logo | `Miter` |
| `BRAND_PRIMARY` | Accent colour (highlights, step labels, click ripples) | `#680BBD` (Miter purple) |
| `BRAND_DARK` | Background behind the page and captions | `#260F14` (Miter midnight) |
| `BRAND_LOGO_URL` | https link to a PNG/SVG logo (or commit `brand/logo.svg` or `brand/logo.png`) | `brand/logo.svg` (Miter logo from miter.com) |
| `BRAND_LOGO_DARK_URL` | Logo for white backgrounds (or commit `brand/logo-dark.svg`) | `brand/logo-dark.svg` |
| `RECORD_ZOOM` | The app is recorded in a 1920×1080 window zoomed to this factor, for sharp 1080p | `1.5` |
| `BRAND_TAGLINE` / `BRAND_SUPPORT` | Lines on the intro and closing cards | `Miter Help Center` / support line |
| `NARRATION` | `on` adds a spoken voiceover (OpenRouter text-to-speech); captions are always on | off |
| `TTS_MODEL` / `TTS_VOICE` | Voice model and voice | `mistralai/voxtral-mini-tts-3-0` / `en_paul_neutral` |

If text-to-speech fails, the video is still made with captions only.

## Saved logins (apps that need sign-in, e.g. Miter staging)

1. On the dashboard, under **Saved logins**, enter a name (e.g. `miter-staging`) and the sign-in page, then press **Open login window**.
2. A live view of the cloud browser opens. Sign in yourself: click on the picture to click, type in the box under it.
   If the site emails you a sign-in link, paste it into the link box at the top. Press **Save login** once you're in.
3. When describing a video, pick the login under **Signed in as**. Leave "Start at" empty to start where you signed in.

Only the browser session (cookies and local storage) is stored, encrypted in MongoDB with `LOGIN_SECRET`
(falls back to `DEMO_PASSWORD`). Passwords are never stored. While signed in, Claude follows extra rules: no running
payroll, paying, sending, inviting, deleting or changing settings, and it stops before the final Save/Submit unless asked.
Use a test account with demo data: share links are public and videos show whatever is on screen.

## Video polish and outputs (several ideas borrowed from [aidemo](https://github.com/tandryukha/aidemo), MIT)

- **Intro and outro:** every video opens with a spoken intro that lists the steps, and closes with a recap and an
  optional "Check your work" list. Claude writes `intro`, `outro` and `checks` when planning; ready-made storyboards
  can set them, or get sensible defaults.
- **Dead-time trimming:** moments where nothing moves (page loads, spinners) are cut, keeping only what each step
  needs for its narration. Long waits (e.g. Miter AI building a report) get an "About 3 minutes later" label.
- **Captions** are split into short lines timed across the spoken sentence.
- **Written SOP:** each video gets one screenshot per step and numbered instructions. See it on the share page,
  or download it as Markdown (`/videos/<slug>/sop.md`).
- **Quality checks** on the finished file (blank screens, silent voice, captions that flash by, overly long videos)
  show as warnings in the dashboard.
- **Blurring:** SSNs, EINs and 9+ digit account numbers are blurred on screen before recording.
  `REDACT=off` disables it; `REDACT_PATTERNS='["regex", ...]'` replaces the patterns.
- **Re-record after app updates:** "Re-record" / "Re-record all" in the dashboard, or
  `POST /videos/rerecord` (body `{}`, `{"status":"approved"}` or `{"slugs":[...]}`) from a deploy hook or schedule.
  Replays saved steps with no Claude cost. If the steps no longer work, the video is flagged in the dashboard.

### Video style

Purple intro card ("How to … in Miter" with the list of steps), full-screen app with a "Miter | Step 2 of 4"
chip top-right and purple caption pills, a pulsing ring around each control before it is clicked, and a short
white "That's it!" closing card. Font: Plus Jakarta Sans (bundled via npm).

Captions sit at the bottom, and move to the top while the control being used is in the lower 40% of the
screen, so they never cover it. Zooms work straight from the 1080p recording (no upscaling), so text stays
sharp; frames outside a zoom are passed through untouched.

### Voices

Pick a voice per video in the dashboard (both request forms, and next to Re-record), or pass `"voice"` to
`POST /prompts`, `POST /jobs` or `POST /videos/rerecord`: `paul` (Voxtral, about 0.8¢ a video), `sarah-v4`
(ElevenLabs v4, about 4.8¢) or `sarah-turbo` (same Sarah voice on v4 Turbo, about 2.4¢). The choice is saved with
the video, so re-recording keeps it. The default is whatever TTS_MODEL / TTS_VOICE are set to. If a voice
fails, the video falls back to the default voice instead of losing narration. Voices are listed in src/voices.mjs.

### AI takeover when a step stops working

Re-records replay saved steps with no AI. If a step fails (a renamed or moved button, a new popup, a slow
page), the recorder first waits for the page to settle and tries again. If it still fails, the AI takes over:
it gets a screenshot, the page's buttons and fields, the failed step and what the video is about, and does
what the step meant to do (or what has to happen first, like closing a popup). Recording carries on, and the
failed tries and thinking time are cut from the video. The fix is saved into the video's steps, so the next
re-record needs no AI, and the video shows "The AI fixed a step … check that the narration still matches".
If it can't fix it, the job fails with the AI's reason and a screenshot.

All AI calls go through OpenRouter: `AUTHOR_MODEL` plans videos, `REPAIR_MODEL` (defaults to AUTHOR_MODEL)
takes over; any OpenRouter model id works (the takeover sends a screenshot, so pick one that reads images).
`REPAIR=off` turns the takeover off; `REPAIR_MAX_TURNS` (default 4) limits tries per step. It only costs
anything when a step breaks, typically 1-5 cents.

### Quality checks and automatic fixes

Every finished video is checked. Warnings have codes, and some are fixed automatically, once each:

| Warning | What happens |
|---|---|
| Voice silent or very quiet | The voice is made again and the video re-edited (same recording). |
| A step ends on a blank screen | Re-recorded once in slow mode (longer waits for pages to load). |
| Caption shorter than a second | Prevented: captions are merged until each shows at least 1.2 s. |
| Video longer than 6 minutes | Flagged only (split it into separate videos). |

If a fix doesn't help, the video stays a draft with the warning and what was tried, for a person to decide.

### Script and caption rules

Claude writes narration by a short style guide (see `SCRIPT_RULES` in `src/author.mjs`): one idea per sentence
(under ~15 words), location first then the action with the exact on-screen label ("In Spend, open Reimbursements."),
"select / enter / choose / turn on", exact values spoken, no filler, and a short intro that states the outcome and
the number of steps. Captions follow broadcast subtitle limits (2 lines of ~42 characters, at least 1.2 s each,
broken at phrase boundaries). The written SOP uses the same wording ("In **Amount**, enter `42.50`.").
