#!/usr/bin/env bash
# Run in Google Cloud Shell, from the repo folder: bash cloudrun/setup.sh
# Builds the same Docker image Render uses and creates (or updates) the Cloud Run job "docs-to-video".
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${REGION:-us-east4}"
PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
[ -n "$PROJECT" ] || { echo "Pick a project first: gcloud config set project YOUR_PROJECT_ID"; exit 1; }

if [ ! -f cloudrun/env.yaml ]; then
  cp cloudrun/env.example.yaml cloudrun/env.yaml
  echo "Created cloudrun/env.yaml. Open it (cloudshell edit cloudrun/env.yaml), paste the values from Render's"
  echo "Environment tab, then run: bash cloudrun/setup.sh"
  exit 1
fi
if grep -q 'PASTE' cloudrun/env.yaml; then
  echo "cloudrun/env.yaml still has PASTE placeholders. Fill them in (or delete lines you don't use), then run this again."
  exit 1
fi

echo "== Turning on Cloud Run, Cloud Build and Artifact Registry for $PROJECT"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

if ! gcloud artifacts repositories describe docs-to-video --location "$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create docs-to-video --repository-format docker --location "$REGION" --description "docs-to-video worker image"
fi
IMAGE="$REGION-docker.pkg.dev/$PROJECT/docs-to-video/worker:latest"

echo "== Building the image (about 5 minutes the first time). env.yaml is not uploaded (it's in .gitignore)."
gcloud builds submit --config cloudrun/cloudbuild.yaml --substitutions "_IMAGE=$IMAGE" .

echo "== Creating the Cloud Run job"
gcloud run jobs deploy docs-to-video \
  --image "$IMAGE" --region "$REGION" \
  --cpu 4 --memory 8Gi --tasks 1 --max-retries 0 --task-timeout 3600 \
  --command node --args src/worker.mjs \
  --env-vars-file cloudrun/env.yaml

echo
echo "Done. To record: set Settings -> 'Where videos record' to Google Cloud Run, queue a video, then run:"
echo "  bash cloudrun/run.sh        (one machine per waiting video: bash cloudrun/run.sh 5)"
