---
title: Publication token + release identity — coordinating two publishers without locks
date: 2026-09-12
category: architecture
---

# Publication token + release identity — coordinating two publishers without locks

Plan: `docs/plans/2026-09-12-1811-feat-deployment-coordination-plan.md`. Builds on
[[2026-06-13-canvas-hosting-deploy-patterns]], [[2026-06-13-dual-dialect-drizzle-seam]]
and [[2026-06-17-dialect-unique-violation-catch]].

## The problem

A local tool and a CI job can both build and deploy the same commit. Before this round
every deploy was a new version with an unconditional pointer swap, so the loser created a
redundant version, repeated the deploy side effects, and could overwrite whatever went live
in between (including a human's editor publish).

## The shape that works

- **One conditional UPDATE is the commit.** `canvasesRepository.activateVersion(id,
  versionId, { expectedToken? })` moves `current_version_id`, clears `revoked_at`, mints a
  fresh `publication_token` and returns it — WHERE the canvas is not being purged, the
  candidate is a READY version of THIS canvas, and (when supplied) the stored token still
  equals the expected one. No transaction, no in-memory mutex: the comparison and the swap
  are the same statement on both dialects, so two activations can never both pass on one
  observed token. `setCurrentVersionIfReady` is now a thin wrapper over it.
- **Rotation by construction.** Every `currentVersionId` assignment in `canvases.ts` goes
  through `livePointerSet(fields)`, which spreads a fresh token; a source-scan test
  (`canvases.test.ts`) fails on any assignment outside it. This is what makes "every
  publication change rotates the token" (deploy, editor publish, rollback, unpublish,
  authoring revoke, purge) a construction rather than a convention.
- **A partial unique index decides a same-release race.**
  `versions_canvas_release_ready_uq` on `(canvas_id, release_id) WHERE status = 'ready'
  AND release_id IS NOT NULL`. Two candidates may be pending together; the second
  `markReady` fails with a unique violation. A `NOT EXISTS` predicate alone would not do:
  under Postgres READ COMMITTED two concurrent statements can both pass (write skew).
  Write the predicate with inline SQL literals — an interpolated JS value becomes a bind
  placeholder inside `CREATE INDEX`. drizzle-kit 0.31 emits the `WHERE` for both dialects.
- **The race window between markReady and the swap.** The loser cannot tell a winner
  that is milliseconds from activating from a crashed one or a historical release.
  `awaitHolder` (deploy/publication.ts) polls up to 20 × 100 ms while the holder is
  "in flight" — ready, not current, and created within the last 60 s. Four exits: holder
  current → `already_current`; holder gone (the winner's own activation failed and it
  deleted its candidate) → retry `markReady`; holder older than the window → history,
  `RELEASE_NOT_CURRENT` at once; timeout → `RELEASE_NOT_CURRENT` naming the holder (a
  crashed winner leaves a ready row the caller can roll back to). Age, not version
  number, is the in-flight signal: after a rollback the historical release is *newer*
  than the live one.
- **Pre-check, then authoritative check.** Every entry path (ZIP, staged begin, staged
  finalize, MCP) answers the cheap cases before ingesting or claiming anything, but only
  the conditional activation is trusted. Non-activation outcomes run none of the side
  effects — and the deploy audit event is written by the *callers* (route helper,
  finalize route, MCP tools), so the gate `result.outcome === "published"` lives there.

## Decisions worth remembering

- **Staged finalize keeps consume-before-commit** (the double-publish guard) and
  un-consumes only on a `PublicationConflictError`, which is raised before the pointer
  moves. A repeated finalize of a consumed session whose release is live answers
  `already_current` (the lost-response case); otherwise `UPLOAD_ALREADY_FINALIZED` as before.
- **Blob GC grace for consumed sessions.** `listActiveByCanvas` also returns sessions
  consumed within `CONSUMED_GRACE_MS` (60 s), so a handle a conflict is about to un-consume
  never has its staged blobs swept in between.
- **Fence `unconsume` on the claimed lease.** `claimForFinalize` returns the row with the
  `finalizingAt` it stamped; `unconsume(id, leaseStamp)` reopens the handle only while that
  stamp is still current. A finalize that outlives `FINALIZE_LEASE_MS` (2000 sequential
  `storage.exists` calls on slow storage) loses its lease to the client's retry; without the
  fence its own token conflict would reopen the handle the retry had already published
  (caught by the cross-model review).
- **Best-effort cleanup is retried, and its final failure is an error log.** A candidate
  that lost the conditional activation is a ready row still carrying its release id, so a
  failed `deleteReadyNonCurrentById` makes the next deploy of that release read
  `RELEASE_NOT_CURRENT` naming a cleanup artifact. `removeLostCandidate` retries three
  times and logs the orphan's version id at error level; `delete_version` removes it by hand.
- **`''` is a legal token value in the schema** (`NOT NULL DEFAULT ''`) so both dialects
  can `ADD COLUMN`. The migration backfills, and `mintMissingPublicationTokens()` runs
  inside `runMigrations` and at the end of `restoreBackup`, because the restore CLI
  inserts rows verbatim and a pre-0043 backup would otherwise restore with empty tokens.
- **Random 128-bit tokens, no historical uniqueness index.** "Never reused" in the
  requirement is the practical guarantee 16 random bytes give; the CAS compares only the
  current value by design.

## Gotcha that bit twice: wire `uploadSessions` into the engine in tests

`deployEngine({ … })` takes an optional `uploadSessions` repository that joins the blob-GC
live set. Production wiring passes it; two test harnesses (the Deploy API route tests and
the MCP `connect()` helper) did not. Any scenario that publishes *between* staging and
finalize then triggers the async prune → GC sweeps the staged blob → finalize fails
`UPLOAD_MISSING_BLOB`. When a staged-flow test fails that way, check the engine wiring
before suspecting the flow.

## Where the contract is documented

`docs/site/api/deploy-api.md` → "Coordinate two publishers" (outcomes, exact bodies, the
staged rules, a local-publisher + GitHub Actions recipe), plus the MCP page, `llms.txt`
source, the agent skill, and the install page's upgrade note (migration 0043,
PostgreSQL 13+ for `gen_random_uuid()`).
