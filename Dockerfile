# syntax=docker/dockerfile:1
#
# canvas-drop — one application image (BUILD_BRIEF §8.3).
# Multi-stage: a builder that compiles the workspace, and a slim, non-root runtime.
# Dependencies (Postgres, the reverse proxy / IAP, optional MinIO) are NOT baked in —
# they are separate off-the-shelf containers wired by docker-compose.yml.

# ── builder ───────────────────────────────────────────────────────────────────
FROM node:24-slim AS builder
WORKDIR /app

# better-sqlite3 compiles from source via node-gyp (it is under `allowBuilds` in
# pnpm-workspace.yaml) and node:24-slim ships no compiler. @node-rs/argon2 ships
# prebuilt napi binaries and needs none. The runtime stage needs neither.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# pnpm via corepack, pinned to the repo's packageManager.
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.0.9 --activate

# Whole workspace (the .dockerignore keeps node_modules/dist/.env/.git out), then
# install + build in topo order (shared → sdk → dashboard → server).
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV CANVAS_DROP_PORT=3000

# Dedicated non-root user (§8.3 — no root in the runtime).
RUN groupadd --system --gid 1001 canvasdrop \
 && useradd  --system --uid 1001 --gid canvasdrop --home /app canvasdrop

# Copy the built workspace as a whole so pnpm's symlinked store, the compiled
# native binaries (better-sqlite3, @node-rs/argon2), and the `node-dist` export
# condition all resolve intact. (Image-size trimming via `pnpm deploy --prod` is a
# tracked follow-up; correctness-first for the first green image.)
COPY --from=builder --chown=canvasdrop:canvasdrop /app /app

# The dashboard is a sibling workspace package (not a server dependency); point the
# server at its built SPA explicitly rather than relying on relative walk-up.
ENV CANVAS_DROP_DASHBOARD_DIST=/app/apps/dashboard/dist

# ── Screenshots / Chromium (OPTIONAL — OFF by default, plan 004 / M10) ──────────
# The canvas screenshot pipeline (dashboard/gallery covers + public OG) needs a
# headless Chromium at runtime. It is deliberately NOT in the default image:
#   • Chromium + its system libs add ~300MB to an otherwise-slim image; and
#   • the feature ships DISABLED (env CANVAS_DROP_SCREENSHOTS defaults to `off`, and
#     even when env-available an admin must turn it on). With it off the product
#     behaves exactly as before — no browser is ever launched.
# To build an image WITH capture, pass `--build-arg SCREENSHOTS=1`. That installs
# Chromium + libs into a shared, non-root-readable path; then run the container with
# CANVAS_DROP_SCREENSHOTS=on and flip the admin toggle in the dashboard. The default
# build (SCREENSHOTS=0) skips this entirely. See docs/site/self-hosting/screenshots.md.
ARG SCREENSHOTS=0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN if [ "$SCREENSHOTS" = "1" ]; then \
      mkdir -p /ms-playwright \
      && node /app/node_modules/playwright-core/cli.js install --with-deps chromium \
      && chown -R canvasdrop:canvasdrop /ms-playwright \
      && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "screenshots: Chromium NOT installed (build with --build-arg SCREENSHOTS=1 to enable)"; \
    fi

# Writable data dir owned by the non-root user. A fresh named volume mounted here
# inherits this ownership (Docker seeds an empty volume from the image mountpoint),
# so local storage / SQLite work without a root container or an init chown.
RUN mkdir -p /data/storage && chown -R canvasdrop:canvasdrop /data
ENV CANVAS_DROP_STORAGE_PATH=/data/storage
ENV CANVAS_DROP_SQLITE_PATH=/data/canvasdrop.db
VOLUME /data

EXPOSE 3000

# /healthz pings the DB and returns 503 until it is reachable — give Postgres time
# to come up AND migrations to run on a cold `docker compose up` (a large migration
# set on a constrained box can take a while) before marking the container unhealthy.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER canvasdrop

# Run compiled JS with the node-dist export condition (so @canvas-drop/shared
# resolves to compiled JS, not TS source) — matches `apps/server` `start`.
CMD ["node", "--conditions=node-dist", "apps/server/dist/index.js"]
