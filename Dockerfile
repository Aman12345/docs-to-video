# One image for both Render services (video-api and video-worker).
# Microsoft's official Playwright image already contains Chromium and every library it needs.
# Its version must match the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# ffmpeg (with libx264 and libass for captions) and fonts for the compose step.
# Inter and Noto give the recorded app the same look as on a Mac/PC when it relies on system fonts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-inter fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# The optional "extra_ca" secret is only for building behind a corporate/sandbox proxy; Render doesn't need it.
RUN --mount=type=secret,id=extra_ca,required=false \
    sh -c '[ -f /run/secrets/extra_ca ] && export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; npm ci --omit=dev'
COPY src ./src
COPY demo-app ./demo-app
COPY storyboards ./storyboards

ENV NODE_ENV=production
# Render sets PORT for web services. Default = demo mode (page, API and worker in one service).
# Production splits them: "node src/api.mjs" and "node src/worker.mjs" (see render.yaml).
CMD ["node", "src/server.mjs"]
