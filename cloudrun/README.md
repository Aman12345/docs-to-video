# Test: record videos on Google Cloud Run

Each video runs in its own fresh machine on Google's servers (4 CPUs, 8 GB) and the machine shuts down
when the video is saved. You pay only while a video is recording (about 5 cents for a 10-minute video;
Google's free tier covers roughly the first 100 a month). The dashboard, share pages and MongoDB stay
exactly as they are on Render.

## One-time setup (about 10 minutes)

1. Open https://console.cloud.google.com, create or pick a project, and make sure billing is turned on
   for it (Billing in the menu).
2. Open **Cloud Shell** (the `>_` button at the top right). It's a terminal in your browser that is
   already signed in to your Google account.
3. Paste:

   ```bash
   git clone https://github.com/Aman12345/docs-to-video.git && cd docs-to-video
   gcloud config set project YOUR_PROJECT_ID
   bash cloudrun/setup.sh
   ```

   The first run creates `cloudrun/env.yaml` and stops. Open it (`cloudshell edit cloudrun/env.yaml`)
   and paste the values from Render: dashboard → docs-to-video-demo → Environment. They stay in your
   Cloud Shell and in the Cloud Run job's settings; `env.yaml` is never committed to git.
4. Run `bash cloudrun/setup.sh` again. It turns on the Google services it needs, builds the same Docker
   image Render uses (about 5 minutes the first time) and creates a Cloud Run job called
   `docs-to-video`.

If the repo is private, use `gh repo clone Aman12345/docs-to-video` (Cloud Shell has `gh`) or a GitHub
token when git asks.

MongoDB Atlas must accept connections from Google's servers: Atlas → Network Access must include
`0.0.0.0/0` (Cloud Run has no fixed address). The password in your MongoDB connection string still
protects the database.

## Make a test video

1. Dashboard → **Settings** → *Where videos record* → **Google Cloud Run (test)** → Save.
2. Queue a video as usual (or select **Re-record** on an existing one). It shows "(Google Cloud Run)" and
   waits in the queue.
3. In Cloud Shell: `bash cloudrun/run.sh` — starts one machine per waiting video (`bash cloudrun/run.sh 5`
   starts five at once). Follow progress in the dashboard's **activity** link, or in Cloud Shell.
4. Compare it with the same video recorded on Render. Switch Settings back to **Render** when done.

## Updating after code changes

Run `bash cloudrun/setup.sh` again in Cloud Shell after `git pull`; it rebuilds the image and updates
the job.
