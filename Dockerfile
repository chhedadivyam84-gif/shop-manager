# Node 24, not 22: the app stores everything in node:sqlite, which is only
# stable from Node 24 — on 22 it needs --experimental-sqlite and can change
# under you between patch releases.
FROM node:24-slim

# tzdata so Asia/Kolkata actually resolves. server/index.js sets
# process.env.TZ before the first Date is created, but without the zone files
# installed the container silently stays on UTC — which puts every bill and
# report entered after 18:30 IST on the wrong day.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/*
ENV TZ=Asia/Kolkata

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Everything that must survive a redeploy lives in /app/data. Mount a
# persistent disk there: a Railway Volume at /app/data, a Fly volume, or
# `docker run -v shopdata:/app/data`. Without one, the app falls back to
# the last cloud backup at every restart.
#
# No VOLUME line: Railway refuses to build a Dockerfile that has one
# ("docker VOLUME is not supported, use Railway Volumes"), and the disk is
# attached in the host's settings instead.

CMD ["node", "--no-warnings", "server/index.js"]
