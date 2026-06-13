---
title: Known race — purge vs an in-flight deploy (accepted, low-probability)
type: architecture
area: deploy
date: 2026-06-13
---

A code review of `chore/polish-dashboard` surfaced a concurrency hazard between the
soft-delete **purge** sweep and an **in-flight deploy**. We deliberately **accepted**
it rather than hardening, given the trust model. This note records the race, why it's
low-risk today, and the trigger that should make us revisit. Builds on
[[canvas-hosting-deploy-patterns]].

## The race

1. A deploy to canvas X is mid-flight: `engine.deploy` has created a `pending`
   version row and is uploading objects under that version's prefix.
2. X is soft-deleted (`status='deleted'`) — the in-flight deploy holds no lock and is
   unaffected.
3. `purge` runs (`apps/server/src/canvas/purge.ts`) and, for X, does
   `storage.deleteMany(keys)` → `versions.deleteByCanvas(X)` (no status filter, so it
   drops the `pending` row too) → `clearCurrentVersion(X)`.
4. The deploy resumes: remaining `put`s re-create objects purge just removed
   (orphans), and `markReady(version.id)` updates **0 rows** (the row is gone). The
   engine does not check `markReady`'s row count, so finalize proceeds against a
   version that no longer exists.

Net: orphaned storage objects and/or a canvas left in a broken state. Permanent —
the next purge skips X (`listByCanvas` is empty).

## Why we accepted it (trust-model calibration)

- **Purge is a manual maintenance script** (`pnpm purge`), not a scheduled job. The
  race needs purge to run in the exact window of an in-flight deploy to a
  *just-deleted* canvas. At single-operator self-host scale, the operator controls
  when purge runs and would not normally purge while actively deploying.
- The **public-facing invariant is intact**: a deleted/archived canvas already 404s
  (`decideCanvasAccess`), so no visitor sees a broken canvas — the damage is orphaned
  storage + a dead row, not an exposure or auth break.
- The safe half is **already shipped**: deploy finalize now wraps
  `markReady`→`setCurrentVersion` so a failed pointer-swap runs `cleanupPending` and
  rethrows instead of orphaning a ready-but-uncurrent version (`engine.ts`). Storage
  delete failures in prune/cleanup now log instead of swallowing silently.

This is the "right-size beyond the hard invariants" calibration: §12 invariants are
P0; this is a non-invariant data-integrity edge with a low realistic trigger.

## Revisit when

Harden (the cheap guard we scoped but did **not** apply) if any of these become true:

- **Purge becomes a scheduled/cron job**, or runs on an HA scheduler with >1 host.
- **A multi-tenant / higher-volume deployment** where deletes and deploys overlap
  routinely.

The cheap guard, if/when needed:

1. `versions.markReady` asserts it updated exactly one row (throw if 0) → the deploy
   fails cleanly and the existing finalize `cleanupPending` runs, instead of
   finalizing against a vanished row.
2. `purge` skips any canvas soft-deleted within a recent window (e.g. the last hour —
   well beyond any deploy's duration), so an in-flight deploy's canvas is never
   swept mid-flight.

Neither needs locks. The strict alternative (transactional finalize guarded on canvas
status + a status filter on `deleteByCanvas`) is correct but heavier and was judged
unnecessary for the current threat model.
