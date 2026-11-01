#!/usr/bin/env bash
# Starts Cloud Run machines for videos waiting in the queue: bash cloudrun/run.sh [how many at once]
# Each machine records one waiting video (sent to Google Cloud Run from the dashboard) and shuts down.
set -euo pipefail
REGION="${REGION:-us-east4}"
TASKS="${1:-1}"
echo "Starting $TASKS machine(s); follow progress in the dashboard's activity link."
gcloud run jobs execute docs-to-video --region "$REGION" --tasks "$TASKS" --wait
echo "Finished. The video(s) are in the dashboard."
