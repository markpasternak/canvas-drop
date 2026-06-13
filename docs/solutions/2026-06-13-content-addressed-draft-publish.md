---
title: Content-addressed blobs + draft/publish model (M5) — seam, GC, and the blob-GC race
type: architecture
area: storage
date: 2026-06-13
---

M5 flipped canvas file storage from per-version copies to **content-addressed
per-canvas blobs** and added a **mutable draft + explicit Publish** model. This note
records the seam decisions and the one accepted race, so future work on storage,
pruning, or the editor builds on it rather than re-deriving it. Builds on
[[canvas-hosting-deploy-patterns]] and [[purge-vs-deploy-race]].

## The shape

- **Blobs are keyed `canvases/{canvasId}/blobs/{sha256}`** (`apps/server/src/canvas/storage-keys.ts`).
  Per-canvas, not global: dedup is within a canvas (all AE1 needs — edit 1 of 20 files
  → 1 new blob), refcounting is canvas-scoped, and purge deletes the whole prefix in one
  call. Global blobs would force cross-canvas refcount coordination and couple data
  lifecycles — rejected for the trust model ([[trust-model-calibration]]).
- **A version is a manifest** (`path → {size, hash, mime}`) over shared blobs — the shape
  was already there; only the storage *key* changed (`blobKey(canvasId, hash)` instead of
  `versions/{versionId}/{path}`). Serving, ETag, and caching are unchanged.
- **The draft is a dedicated `drafts` table** (one row per canvas, unique `canvas_id`),
  NOT a `versions.status='draft'` row. This keeps the per-canvas `number` sequence and
  keep-last-10 cap **published-only**, and leaves the existing rollback/prune race logic
  untouched.
- **Publish is a manifest op, not a byte copy** (`apps/server/src/draft/service.ts`).
  Editor writes upload blobs during editing, so Publish just creates a `ready` version
  with the draft's manifest + swaps the pointer. Restore copies a version's manifest into
  the draft. Both are effectively instant.

## Pruning is now two separate things

`versions.pruneBeyond` deletes version **rows** only (keep-last-10), keeping its atomic
live-pointer guard. **Blob reclamation is a separate per-canvas mark-sweep**
(`apps/server/src/canvas/blob-gc.ts`): live hash set = union of manifests across all
`ready` versions ∪ the draft; list the canvas blob prefix; delete blobs whose hash isn't
live. This one sweep subsumes both pruned-version blobs and draft-churn orphans (a file
edited h1→h2 leaves h1). **Never delete blobs inline** on a failed deploy or row-prune —
a blob may be shared with the live version; only the mark-sweep, which sees the whole live
set, may delete.

## The accepted race (blob GC vs concurrent publish)

A publish concurrent with the sweep could, in a narrow window, reference a blob the sweep
is about to delete. **Accepted** at D13 single-org scale, like [[purge-vs-deploy-race]]:
GC runs after row-pruning reading a fresh live set; blob puts are idempotent so a
re-publish/re-deploy re-writes any wrongly-swept blob; and serving already 404s a missing
asset rather than crashing. Revisit if canvases get multi-writer or much higher publish
concurrency.

## Gotchas worth keeping

- **`stale` belongs in the engine, not each route.** Any direct publish (Bearer deploy
  API, folder/ZIP, paste) supersedes a held draft. Marking the draft stale inside
  `engine.deploy` (after the pointer swap) covers the *entire* direct-publish surface —
  including the programmatic API — in one place. The editor's own Publish goes through the
  draft service (manifest snapshot), not `engine.deploy`, so it never wrongly self-stales.
- **Draft preview stays on the dashboard origin.** `GET /api/canvases/:id/preview/*`
  (owner-only, `no-store`) streams draft blobs via the shared `asset-resolver`. The public
  canvas origin only ever serves published versions — drafts never transit it.
- **Raw-file fetches break the JSON auth-expiry heuristic.** The dashboard's shared
  `request()` treats a 2xx non-JSON body as a proxy login page (session expiry). Draft
  file content is legitimately non-JSON (HTML/CSS/JS), so `api.getDraftFile` narrows
  auth-expiry to `401 || res.redirected`. Any future raw-body GET must do the same or it
  will redirect to login on every successful load.
- **CodeMirror is lazy-loaded.** The editor route is its own chunk (~520 kB) so CodeMirror
  only loads when the editor opens — it never weighs on the dashboard's initial bundle.
