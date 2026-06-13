---
title: Canvas hosting + deploy — the patterns areas E/G/R build on
type: architecture
area: routing
date: 2026-06-13
---

Reference for anyone touching canvas serving, the deploy pipeline, or canvas-scoped
APIs (areas E dashboard, F–J/R primitives). Builds on [[auth-invariant-checklist]]
and [[dual-dialect-drizzle-seam]].

## Canvas authorization is a pure decision table + a thin middleware

`apps/server/src/canvas/authorization.ts` splits into `decideCanvasAccess(canvas,
user, now)` (pure, exhaustively unit-tested) and the `canvasAccess` middleware
(HTTP glue). **Order is the invariant** (and is itself tested): deleted→404 →
disabled→403 → owner/admin→allow → not-shared→404 (owner-only, no existence leak)
→ expired→404 → shared+live→allow (defer to gate). No cached grants — re-read
`findBySlug` every request so revoke/expiry/disable are honored on the next hit.
Any new canvas-scoped surface (KV, files, realtime) should reuse `canvasAccess`,
not re-derive access.

## Two auth paths, deliberately

- **Session gateway** (foundation) fronts canvas *content* (`/c/{slug}`) and the
  management API (`/api/canvases`) — login on every request.
- **Bearer-key API** (`/v1/canvases/:id`, `Authorization: Bearer cd_…`) mounts
  **before** the session gateway in `app.ts`, because agents/CI have no org
  session (§4.5). A key resolves the canvas by SHA-256 hash (active-only) and
  must match `:id` — a key for A can't touch B. The canvas-*facing* platform API
  (`/v1/c/:slug`, areas F–R) is a third path (session-cookie from canvas JS) —
  don't confuse it with the Bearer deploy API.

The `role` is set once (from `resolveRequest`) and canvas middlewares are gated
with an `onlyCanvas(mw)` wrapper.

## Deploy engine: one core, three thin adapters

`deploy(canvas, source, entries, actor)` is source-agnostic — folder/ZIP/paste
differ only in how they produce the `{path, bytes}` stream. Key invariants:

- **Stream entries, buffer one file** (KTD-2): `fromZip` uses `yauzl` with
  `lazyEntries` + pull-after-consume, checking each entry's declared
  `uncompressedSize` **before** inflating (zip-bomb defense — a post-inflate cap
  is too late). yauzl rejects `..`/absolute names at the library level; we map
  those to the stable `ZIP_SLIP_REJECTED` code. `normalizeEntryPath` is the
  second guard + dotfile strip.
- **Storage layout** `versions/{versionId}/{path}` — a version's bytes are isolated
  so the pointer swap and pruning never touch the live version.
- **Atomic-ish commit**: write all files (pending row) → `markReady` →
  `setCurrentVersion` (the pointer swap is the commit). A failure before the swap
  leaves the live version untouched; orphaned pending writes are cleaned up, and
  an orphan *ready* version (crash between the two writes) is bounded — normal
  pruning keeps only the newest 10 ready versions. (A single cross-dialect
  transaction was skipped: better-sqlite3's drizzle transaction callback is
  sync-only, awkward with our async repos; the bounded-orphan behavior is the
  trust-model-calibrated call.)
- **Concurrent deploys** to one canvas race `nextNumber`; the `(canvas_id, number)`
  unique index makes a collision a constraint error → `createVersionWithRetry`
  retries instead of surfacing a 500.
- **Prune is async + re-reads the live pointer** so a concurrent rollback's
  current version is never deleted; storage-delete failures are log-and-continue.
- **Stable error codes** (`errors.ts`) are an API contract (§9.5.4) — agents
  repair from them. Don't rename without versioning.

## Serving

`serve.ts`: resolve `currentVersionId` → ready version + manifest; `assetPathFor`
strips `/c/{slug}` in path mode (raw path in subdomain mode); `resolveAsset` does
exact → dir/root `index.html` → SPA fallback → 404. `ETag` = manifest content
hash; `no-cache` for stable names (instant redeploy via the pointer swap),
`immutable` only for content-hashed filenames. Executables/unknown → `text/plain`
+ `nosniff`; §12.4 headers on 200 **and** 304.

## Resource safety on a small VPS (the trust-model lens)

`bodyLimit` rejects oversized deploy bodies before buffering; the S3 client has
request/connection timeouts. These are *accident/resource* defenses (a colleague's
huge upload, a slow endpoint), not anti-DoS — the right framing for a trusted-org
product. See [[trust-model-calibration]] / the auth-invariant-checklist.

## Test infra

`apps/server/src/storage/mem.ts` — shared in-memory `StorageDriver` (with a
`failOnPut` hook for atomicity tests). Build ZIP fixtures with `fflate.zipSync`
(dev-only); read with `yauzl`.
