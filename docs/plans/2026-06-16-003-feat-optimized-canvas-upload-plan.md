---
title: "feat: Optimized canvas upload (staging → finalize, two channels, content-addressed manifest)"
type: feat
status: active
date: 2026-06-16
origin: docs/brainstorms/2026-06-16-optimized-canvas-upload-requirements.md
depth: deep
---

# feat: Optimized canvas upload

> Origin: `docs/brainstorms/2026-06-16-optimized-canvas-upload-requirements.md`

## Summary

Deploying files to a canvas currently forces the file bytes through the calling
agent's context window (MCP `deploy_canvas(zipBase64)`), which bloats context and
can silently corrupt the deploy. This plan introduces a **staging → finalize**
upload spine with two interchangeable data-plane channels — an authenticated
**server upload endpoint** (shell-capable agents PUT bytes directly) and a
chunkable **`files` array** MCP call (MCP-only agents) — over one shared service.
A **content-addressed manifest** lets a re-deploy upload only the blobs that
changed. The existing one-call inline deploy stays backward-compatible for small
canvases.

The design leans hard on what already exists: the deploy engine is already
source-agnostic over a `DeployEntry {path, bytes}` stream, storage is already
content-addressed (`blobKey(canvasId, sha256)` + `storage.exists()`), and the
draft/publish flow is already a "stage blobs, then commit a manifest as a ready
version" spine. The new work is a multi-session **upload-session** entity, the
two channel front-ends, the manifest-diff negotiation, and the auth/GC correctness
that a longer-lived staging window demands.

---

## Problem Frame

- **Today:** the only agent deploy path is MCP `deploy_canvas(zipBase64)`
  (`apps/server/src/mcp/server.ts`) or the keyed `PUT /v1/canvases/:id/deploy`
  (`apps/server/src/routes/deploy-api.ts`). Both require the whole archive in the
  request; for MCP the base64 blob is read out of a shell command into the model
  context and re-emitted into the tool call (bytes through the LLM twice), and a
  single mangled character yields `INVALID_ZIP`.
- **Goal:** bytes never enter the model context for shell agents; the common
  (text) case can't corrupt; re-deploys ship only changed blobs; small canvases
  still deploy in one call; one service backs both the MCP and Deploy-API surfaces.
- **Actors:** shell-capable agents (can PUT over HTTP), MCP-only hosts (tool calls
  only). Both are first-class.

---

## Requirements traceability

| Origin requirement | Where addressed |
|---|---|
| Bytes out of model context (shell agents) | U5 (server upload endpoint); U6 (direct channel surfaced via MCP `begin_deploy`) |
| No corruption in the common case | U3 (`files` array: UTF-8 text, base64 only for binary); U6 |
| Re-deploy uploads only changed blobs | U2 (manifest diff; formerly U4) |
| Single-call inline deploy for small canvases (no regression) | U6 (keep `deploy_canvas` inline; add inline `files`) |
| One service backs MCP + Deploy API | U2 (shared service); U5/U6 are thin front-ends |
| Auth invariant on finalize | U2 (identity + ownership re-validation, single-use handle) |
| Staging GC safety | U7 (GC live-set union; stale-session prune) |
| Dual-dialect persistence | U1 (both schema files + both migrations + parity test) |

---

## Key Technical Decisions

- **KTD1 — Staging is a new `upload_sessions` entity, not the editor draft.** The
  draft is a single per-canvas editor state with `If-Draft-Base` optimistic
  concurrency; agents need many independent, concurrent upload sessions. We
  *mirror* the draft's blob mechanics (hash→`exists`→`put`, manifest-as-unit) but
  in a dedicated, owner-scoped, single-use session row. (see origin: open question
  "MCP tool shape / staging model")
- **KTD2 — The "direct upload" channel is an authenticated server HTTP endpoint
  keyed by the upload handle — not a presigned S3 URL.** Presigned S3 cannot serve
  the local-storage driver and would bypass server-side content-addressing /
  validation. A server endpoint streams the blob to whichever `StorageDriver` is
  configured, keeps validation server-side, and still keeps bytes out of the model
  context. Presigned-S3 is explicitly a future optimization, out of scope.
  (confirmed with user; deviates from origin's "signed upload URL" wording)
- **KTD3 — Both channels terminate in content-addressed blob writes; finalize
  reuses the engine's commit tail.** No parallel deploy logic. The per-entry
  hash + `putBlobIfAbsent` loop and the `markReady → setCurrentVersion →
  draft-sync → prune` tail are factored out of `engine.deploy()` so finalize runs
  over an already-staged blob set + the session manifest.
- **KTD4 — Skip-unchanged reuses existing content addressing.** `begin` diffs the
  client manifest hashes against the canvas's existing blobs (`storage.exists()` /
  `list(blobPrefix)`); only missing hashes are uploaded. Finalize is a manifest
  commit, not a byte copy.
- **KTD5 — Upload handle is high-entropy, hashed at rest, idempotent-single-use.**
  The handle reaches a terminal `consumed` state only on a *successful* finalize
  (pointer swap); finalize marks in-progress atomically, and a transient
  `commitVersion` failure clears the mark so a legitimate retry can resume over the
  already-staged blobs (a strict consume-before-commit would strand them — the
  `codes.consume` pattern is safe only because nothing failable runs after consume,
  which is not finalize's shape). Finalize re-loads the owner and `assertUserActive`
  (block-after-issue, both channels), and re-checks ownership through the
  **owner-only** seam (404 on non-owner / admin / missing — no existence leak).
  Staging also checks `callerId === ownerId` and (HTTP) `session.canvasId === :id`.
  Reuse `hashToken` / `generateSessionToken`.
- **KTD6 — Abandoned sessions leave orphan blobs for the existing sweep; never
  delete inline.** A blob may be shared with the live version. The blob-GC live
  set is extended to union in-flight session manifests so a pending finalize's
  blobs aren't swept; sessions get a short TTL and a stale-session prune.
- **KTD7 — Full backward compatibility.** `deploy_canvas(zipBase64)` and
  `PUT /v1/canvases/:id/deploy` are unchanged. A new inline `files` array on
  `deploy_canvas` covers the small one-call case without a session.

---

## High-Level Technical Design

Two channels, one service. `begin` negotiates which blobs are needed; the data
plane stages blobs (content-addressed); `finalize` commits a manifest as a ready
version and swaps the live pointer.

```mermaid
sequenceDiagram
    participant A as Agent
    participant S as Upload/Deploy service
    participant B as Storage (content-addressed blobs)
    participant V as Versions / Canvas pointer

    A->>S: begin(canvasId, manifest[path,sha256,size])
    Note over S: owner re-check (404 if not owned)<br/>mint uploadId (hashed, TTL)<br/>record manifest on session (before any blob)
    S->>B: diff manifest hashes vs existing blobs (exists/list)
    S-->>A: { uploadId, missingHashes[] }

    alt shell agent (bytes bypass model + MCP)
        A->>S: PUT /canvases/:id/uploads/:uploadId/blobs/:hash (raw body)
    else MCP-only agent
        A->>S: add_files(id, uploadId, files[{path,content,encoding}])
    end
    Note over S: callerId==ownerId & session.canvasId==id<br/>verify body sha256 == :hash<br/>putBlobIfAbsent(blobKey(canvasId,hash))

    A->>S: finalize(id, uploadId)
    Note over S: mark in-progress (idempotent single-use)<br/>assertUserActive + owner re-check<br/>assert hashes present + caps; commit, then consume
    S->>V: createPending → markReady(manifest,stats) → setCurrentVersion
    Note over S: draft reconciliation + prune (engine tail)
    S-->>A: { url, version, fileCount, totalBytes }
```

**Reused seams (mirror, don't re-derive):** `DeployEntry {path, bytes}`
(`apps/server/src/deploy/ingest.ts`), `blobKey` / `canvasBlobPrefix`
(`apps/server/src/canvas/storage-keys.ts`), `storage.exists()`
(`apps/server/src/storage/driver.ts`), `createVersionWithRetry` / `markReady` /
`setCurrentVersion` and the draft-sync + prune tail
(`apps/server/src/deploy/engine.ts`, `apps/server/src/draft/service.ts`),
`manifestsEqual` (`apps/server/src/canvas/manifest.ts`), stable codes
(`apps/server/src/deploy/errors.ts`).

---

## Output Structure

`+` = new file, `~` = modified existing file. Per-unit **Files** sections remain
authoritative.

```
apps/server/src/
  upload/
    service.ts          # + UploadService: begin/stageBlob/stageFiles/finalize       (U2)
    service.test.ts     # +                                                          (U2)
    handle.ts           # + high-entropy handle gen + hash                           (U2)
  deploy/
    ingest.ts           # ~ + fromFilesArray adapter                                 (U3)
    engine.ts           # ~ extract commitVersion() for reuse                        (U2)
    errors.ts           # ~ + UPLOAD_* / BLOB_HASH_MISMATCH codes                    (U2)
  routes/
    upload-api.ts       # + begin / per-blob PUT / finalize HTTP routes              (U5)
    upload-api.test.ts  # +                                                          (U5)
    deploy-common.ts    # ~ per-blob body-limit variant + shared error mapper        (U5)
  mcp/
    server.ts           # ~ + begin_deploy/add_files/finalize_deploy + inline files  (U6)
    routes.ts           # ~ thread storage into McpRoutesDeps + buildMcpServer        (U6)
  canvas/
    blob-gc.ts          # ~ union in-flight upload sessions into live set            (U7)
  db/repositories/
    upload-sessions.ts  # + repository (+ .test.ts)                                  (U1)
  app.ts                # ~ mount upload routes; thread storage into deps            (U5/U6)
packages/shared/src/db/
  schema.pg.ts          # ~ + upload_sessions; + 'upload' in versions_source_chk     (U1)
  schema.sqlite.ts      # ~ + upload_sessions; + 'upload' in versions_source_chk     (U1)
  types.ts              # ~ + DeploySource 'upload'; upload-session row type         (U1)
drizzle/
  pg/00NN_*.sql         # + upload_sessions; alter versions_source_chk               (U1)
  sqlite/00NN_*.sql     # + upload_sessions; alter versions_source_chk (table rebuild)(U1)
```

---

## Implementation Units

### U1. `upload_sessions` schema + repository

**Goal:** A dual-dialect table to track an in-flight upload: owner, target canvas,
hashed single-use handle, target manifest, staged-hash set, TTL/expiry,
`consumed_at`.

**Requirements:** Dual-dialect persistence; foundation for U2.
**Dependencies:** none.
**Files:**
- `packages/shared/src/db/schema.pg.ts`, `packages/shared/src/db/schema.sqlite.ts`
  (add `upload_sessions`, built from shared helpers in
  `packages/shared/src/db/columns.ts`; **also add `'upload'` to the existing
  `versions_source_chk` CHECK constraint in both files**)
- `packages/shared/src/db/types.ts` (inferred row type; reuse `Manifest`; add
  `'upload'` to the `DeploySource` union)
- `drizzle/pg/*`, `drizzle/sqlite/*` (generate BOTH migrations, `--name upload_sessions`;
  the SQLite `versions_source_chk` change requires a table rebuild — verify the
  generated migration does this)
- `apps/server/src/db/repositories/upload-sessions.ts` (+ `.test.ts`)
- extend the schema-parity test (`apps/server/src/db/*parity*`)

> **P0 — must land in U1, not U2.** `versions.source` carries a CHECK constraint
> `source in ('folder','zip','paste','api','editor')` in **both** schemas, and
> `createPending` writes `source` directly. Without adding `'upload'` here, every
> finalize in U2 fails the INSERT on both dialects. (feasibility review)

**Approach:** Columns: `id` (uuid v7), `canvasId` (FK → canvases), `ownerId`,
`handleHash` (unique), `manifest` (JSON: `path → {size,hash,mime}`), `stagedHashes`
(JSON set or derived), `expiresAt`, `consumedAt` (nullable), timestamps. Unique
index on `handleHash`; index on `(canvasId)`. Repo methods: `create`,
`findByHandleHash`, `addStagedHash`/`setStaged`, `consume` (atomic
`UPDATE … WHERE consumed_at IS NULL … RETURNING`), `listActiveByCanvas` (for GC),
`deleteExpired`.

**Patterns to follow:** `apps/server/src/db/repositories/versions.ts` and
`drafts.ts`; the atomic `consume` mirrors `codes.consume`/`tokens.consume`. Column
helpers per `docs/solutions/2026-06-13-dual-dialect-drizzle-seam.md`.

**Test scenarios:**
- Parity: `upload_sessions` exists in both dialects with identical columns, the
  `handleHash` unique index, and the canvas FK (use `getTableConfig`).
- `consume` returns the row once and `null` on a second concurrent call (atomic
  single-use) — both dialects via `describe.each(DIALECTS)`.
- `findByHandleHash` returns null for an unknown/expired handle.
- `deleteExpired` removes only rows past `expiresAt`.
- Parity: `versions_source_chk` accepts `'upload'` on both dialects (a `versions`
  row with `source: 'upload'` inserts cleanly).
- Migrations apply cleanly on pglite + sqlite (full suite, not just parity).

---

### U2. Upload/finalize service core

**Goal:** The shared service both front-ends call: `begin` (mint handle + manifest
diff), `stageBlob`/`stageFiles` (content-addressed writes into the session),
`finalize` (commit a ready version). Factor the reusable commit tail out of
`engine.deploy()`.

**Requirements:** One service for both surfaces; auth invariant on finalize.
**Dependencies:** U1.
**Files:**
- `apps/server/src/upload/service.ts` (+ `service.test.ts`)
- `apps/server/src/deploy/engine.ts` (extract `commitVersion(canvas, manifest,
  stats, actorId, source)` = `createVersionWithRetry → markReady →
  setCurrentVersion → draft-sync → prune`; `deploy()` keeps calling it. Keep
  `commitVersion` a method on the engine object so its `this.draftHasUnpublishedEdits`
  / `this.prune` references stay valid; pass `source` as a parameter — `deploy()`
  already threads it, but the draft path hardcodes `"editor"`)
- `apps/server/src/db/repositories/versions.ts` (`markReady` asserts exactly one
  row updated — A3 guard)
- `apps/server/src/deploy/errors.ts` (new stable codes:
  `UPLOAD_HANDLE_INVALID`, `UPLOAD_EXPIRED`, `UPLOAD_ALREADY_FINALIZED`,
  `UPLOAD_MISSING_BLOB`, `BLOB_HASH_MISMATCH`; reuse existing `CANVAS_TOO_LARGE`/
  `TOO_MANY_FILES`)
- `apps/server/src/upload/handle.ts` (high-entropy `uploadId` gen + `handleHash`;
  reuse `hashToken`/`generateSessionToken`)

**Naming convention (resolves handle/uploadId drift):** the public MCP/HTTP
parameter is **`uploadId`** (the one-time plaintext token returned by `begin`); its
SHA-256 is **`handleHash`**, the internal lookup key. Service methods take
`handleHash`; front-ends accept `uploadId` and hash it. "handle" = the credential
generically; never a distinct third name.

**Approach:** `begin(canvas, ownerId, manifest)` — owner already resolved by the
caller (front-end gates), mints a high-entropy `uploadId` (returns plaintext once;
stores only `handleHash`), sets a short TTL (concrete value: **15 min** — longer
than the slowest realistic multi-blob upload, shorter than the purge-skip window
in A3). Diffs `manifest` hashes against existing canvas blobs via `storage.exists()`
(or one `list(canvasBlobPrefix)` + set diff — see manifest-diff approach below),
returns the missing-hash set. **`begin` records the full target manifest on the
session row up front** so the GC live-set union (U7) sees the intended hashes
before any blob is staged (closes the A2 stage-then-record window).
`stageBlob(handleHash, callerId, hash, bytes)` / `stageFiles(handleHash, callerId,
entries)` — load the session; assert `session.ownerId === callerId` **and**, for
the HTTP route, that the session's canvas matches the route `:id` (else
`UPLOAD_HANDLE_INVALID`); verify `sha256(bytes) === hash` (else
`BLOB_HASH_MISMATCH`); `putBlobIfAbsent`; mark the hash staged. `finalize(handleHash,
callerId)` — **idempotent single-use** (see below); re-load the session's owner and
`assertUserActive` (block-after-issue); **owner re-check** of the canvas;
assert every manifest hash is present in storage (else `UPLOAD_MISSING_BLOB`);
assert `manifest` file count ≤ `LIMITS.maxFiles` and Σ`size` ≤
`LIMITS.maxCanvasBytes` (else `TOO_MANY_FILES`/`CANVAS_TOO_LARGE` — the streaming
caps in `engine.deploy()` don't apply to a pre-built manifest); call
`commitVersion(...)` with `DeploySource` `"upload"`. `commitVersion`'s `markReady`
**asserts it updated exactly one row** (A3 cheap guard; a finalize whose canvas was
purged between begin and commit fails cleanly).

**Idempotent finalize (not strict consume-before-commit):** the `codes.consume`
pattern is safe only because nothing failable runs after consume; finalize does.
So: mark the session **in-progress** (atomic `UPDATE … WHERE consumed_at IS NULL`),
run `commitVersion`, and only on the successful pointer-swap set `consumedAt`
(terminal). On a transient `commitVersion` failure, clear the in-progress mark so a
legitimate retry can resume over the already-staged blobs; only a *committed*
handle returns `UPLOAD_ALREADY_FINALIZED`. Two concurrent finalizes still resolve to
exactly one commit.

**assertUserActive source (both channels):** implement as a `users.findById(ownerId)`
+ block/delete check in the shared service — **not** the MCP-provider-specific
helper — so the keyed Deploy-API path (which has no user session) also rejects a
blocked owner. The Deploy-API deps gain a `users` dependency alongside `storage`.

`McpToolDeps`/`McpRoutesDeps` and the Deploy-API deps gain `storage` (and `users`).

**Manifest skip-unchanged (folded in from former U4 — the B spine can land first
with the diff returning "all hashes missing"; the diff is the C optimization on
the same `begin`/`finalize`):** prefer a single
`storage.list(canvasBlobPrefix(canvasId))` → `Set<hash>` then set-difference
against the manifest hashes (one storage round trip) over N× `exists()`. Finalize
**trusts blob existence, not content** for skip-unchanged blobs — matching the
existing `putBlobIfAbsent` semantics (a present content-addressed blob is assumed
intact); content re-verification is out of scope. A cheap `size > 0` guard on the
presence check is the only integrity assertion. (adversarial A4: decision made
explicit.)

**Files (additions):** `apps/server/src/deploy/errors.ts` reuses existing
`CANVAS_TOO_LARGE`/`TOO_MANY_FILES`; add only `UPLOAD_*` and `BLOB_HASH_MISMATCH`.

**Execution note:** Implement the finalize rejection paths test-first — the
green happy path says nothing about the auth gate.

**Patterns to follow:** `apps/server/src/draft/service.ts` `publish()`
(manifest→version, no byte copy); engine commit tail; the §12 checklist
(`docs/solutions/2026-06-13-auth-invariant-checklist.md`) and the MCP
token-lifecycle note (`docs/solutions/2026-06-16-mcp-server-on-hono-and-token-lifecycle.md`).

**Test scenarios:**
- Covers AE: begin with a partial manifest returns exactly the hashes not already
  stored; begin with an all-known manifest returns an empty missing set.
- stage then finalize → new ready version is current; `fileCount`/`totalBytes`
  match the manifest; blobs are content-addressed and de-duplicated.
- finalize re-uses already-present blobs (skip-unchanged): only missing blobs were
  ever written (assert via `mem` driver put count).
- **Auth — block-after-issue:** owner blocked/deleted *after* `begin` but before
  `finalize` → finalize fails (identity re-validated on use). Owner blocked while a
  handle is live → handle revoked.
- **Auth — non-owner / admin:** finalize against a canvas the session owner
  doesn't own → 404-equivalent error, no existence leak; a non-owner admin is not a
  bypass.
- **Single-use:** two concurrent `finalize` calls on one handle → exactly one
  commits, the other gets `UPLOAD_ALREADY_FINALIZED`.
- **Idempotent retry:** `finalize` where `commitVersion` throws transiently → the
  handle is NOT left consumed; a subsequent `finalize` over the same staged blobs
  succeeds.
- **Staging ownership:** `stageBlob`/`stageFiles` with `callerId` ≠
  `session.ownerId` → `UPLOAD_HANDLE_INVALID`, nothing written.
- finalize referencing a hash that was never staged → `UPLOAD_MISSING_BLOB`, no
  version created, live version untouched.
- **Aggregate caps:** a manifest declaring > `maxFiles` or Σsize >
  `maxCanvasBytes` → `TOO_MANY_FILES`/`CANVAS_TOO_LARGE` at finalize, no version
  created.
- `stageBlob` with body whose sha256 ≠ `:hash` → `BLOB_HASH_MISMATCH`, nothing
  written.
- expired handle → `UPLOAD_EXPIRED`.
- canvas soft-deleted between begin and finalize → clean failure (`markReady`
  one-row guard trips), no partial commit.
- concurrent finalizes on *different* handles for the same canvas → both get
  distinct version numbers (`createVersionWithRetry`).
- **Manifest diff (folded from U4):** re-deploy changing one file of N → `begin`
  reports exactly one missing hash; only that blob is uploaded; the committed
  version still references the N−1 already-present blobs. Identical re-deploy →
  empty missing set; finalize with zero staged blobs still produces a correct
  version. A hash present only in another canvas is still requested (per-canvas
  blob namespace).

---

### U3. `fromFilesArray` ingest adapter

**Goal:** Decode `files: [{path, content, encoding}]` into a `DeployEntry` stream
(UTF-8 text as-is; base64 only for binary).

**Requirements:** No corruption in the common case; feeds inline `files` + MCP
`add_files`.
**Dependencies:** none (used by U2/U5/U6).
**Files:** `apps/server/src/deploy/ingest.ts` (+ tests alongside existing ingest tests)

**Approach:** Mirror `fromPasteHtml`/`fromZip`. For each item, decode by
`encoding` (`utf8` default | `base64`) to `Uint8Array`; apply the same
`normalizeEntryPath` discipline the engine uses (zip-slip / absolute-path
rejection) before yielding. `Buffer.from(str,"base64")` never throws — guard on
zero-length, don't try/catch.

**Patterns to follow:** `fromPasteHtml`, `fromZip` in
`apps/server/src/deploy/ingest.ts`; `normalizeEntryPath` in
`apps/server/src/deploy/validate.ts`.

**Test scenarios:**
- UTF-8 text file round-trips byte-exact; multi-file array yields all entries.
- base64 binary decodes to exact bytes; empty/whitespace base64 → skipped/guarded,
  not a throw.
- `..`/absolute path in `path` → `ZIP_SLIP_REJECTED` (same as zip).
- unknown encoding → stable error.

---

### U4. Manifest skip-unchanged negotiation — *merged into U2*

The diff lived on the same `service.ts` `begin`/`finalize` it would have modified,
so keeping it as a separate unit created a false ordering dependency for
inseparable logic (scope review). Its content moved into **U2** ("Manifest
skip-unchanged" approach + the "Manifest diff" test scenarios). The B spine can
still land before the optimization: ship `begin` returning "all hashes missing"
first, then enable the diff — same `begin`/`finalize`, no second unit. U-ID
retired; gap intentional.

---

### U5. Deploy-API HTTP routes (shell-agent direct channel)

**Goal:** Keyed HTTP routes so a shell agent transfers bytes directly to the
server, bypassing both the model and MCP.

**Requirements:** Bytes out of model context for shell agents; one service.
**Dependencies:** U2, U3.
**Files:**
- `apps/server/src/routes/upload-api.ts` (+ `.test.ts`)
- `apps/server/src/routes/deploy-common.ts` (**existing file — extend**: add a
  per-blob body-limit variant, and **extract the `DeployError → {code,message,path}`
  HTTP mapper out of `deployResponse`** into a standalone helper. `deployResponse`
  itself calls `engine.deploy()` internally, so finalize can't reuse it wholesale —
  only the error-mapper is shared. — F4)
- `apps/server/src/app.ts` (`buildApp` — where `deployApiRoutes(...)` is mounted;
  mount the upload routes under the same pre-gateway, key-authed prefix). `storage`
  is already a `buildApp` dep.

**Approach:** `POST /v1/canvases/:id/uploads` (body: manifest) → `authCanvas` +
`UploadService.begin` → `{ uploadId, missingHashes }`. `PUT
/v1/canvases/:id/uploads/:uploadId/blobs/:hash` → `authCanvas` (canvas key) +
resolve session by `hash(uploadId)` and **assert `session.canvasId === :id`**
(else `UPLOAD_HANDLE_INVALID` — prevents presenting a handle minted for one canvas
against another, S1) + per-blob body limit (`LIMITS.maxFileBytes`, 25 MB) →
`stageBlob`. `POST /v1/canvases/:id/uploads/:uploadId/finalize` → `finalize` →
result mapped via the extracted error mapper. Status mapping: `UPLOAD_*`/
`BLOB_HASH_MISMATCH`/`UPLOAD_MISSING_BLOB` → 400; `CANVAS_TOO_LARGE`/
`TOO_MANY_FILES` → 413; non-owner / unknown canvas → 404. Reuse `deployThrottle`.

**Patterns to follow:** `apps/server/src/routes/deploy-api.ts` (`authCanvas`,
`deployThrottle`), `deploy-common.ts` (`deployBodyLimit`).

**Test scenarios:**
- Full happy path over HTTP: begin → PUT each missing blob → finalize → canvas
  serves the new version.
- key for a different canvas → 403 (existing `authCanvas` contract); unknown/
  expired handle on PUT/finalize → stable error.
- **handle/canvas mismatch:** an `uploadId` minted for canvas A presented at
  `/v1/canvases/B/uploads/...` (with B's key) → `UPLOAD_HANDLE_INVALID`, nothing
  staged into B.
- per-blob over the 25 MB cap → 413, nothing staged.
- PUT with body whose sha256 ≠ `:hash` → `BLOB_HASH_MISMATCH`.
- finalize before all missing blobs uploaded → `UPLOAD_MISSING_BLOB`.

---

### U6. MCP tools (MCP-only channel + ergonomics)

**Goal:** Expose the same flow as MCP tools and add an inline `files` array to
`deploy_canvas` for one-call small deploys.

**Requirements:** MCP-only channel; single-call inline deploy; one service.
**Dependencies:** U2, U3.
**Files:** `apps/server/src/mcp/server.ts` (+ `server.test.ts`),
`apps/server/src/mcp/routes.ts` (add `storage` to `McpRoutesDeps` **and** the
`buildMcpServer({...})` call there — `McpToolDeps` is built in `routes.ts`, not
only `server.ts`).

**Approach:** New tools (all `requireOwned(id)`, `caller.userId` from the verified
token, passed to the service as `callerId`): `begin_deploy({id, manifest?})` →
`{ uploadId, missingHashes, uploadBaseUrl? }`; `add_files({id, uploadId, files[]})`
→ `requireOwned(id)` then `stageFiles(hash(uploadId), caller.userId, …)` via
`fromFilesArray`; `finalize_deploy({id, uploadId})` → `requireOwned(id)` then
`finalize`. (Carry `id` on `add_files`/`finalize_deploy` so the tool can
`requireOwned` and the service can assert `session.canvasId === id` —
`uploadId` alone gives the MCP layer no canvas to own-check.) Keep `deploy_canvas`
inline; add optional `files` (array) alongside `zipBase64` for the no-session path
— **reject the both-supplied and neither-supplied cases** with a stable error.
Add `storage` to `McpToolDeps`. Audit each finalize (`action:"deploy",
meta:{source:"mcp-upload"}`). Per-account rate limit already applied in
`routes.ts`.

**Patterns to follow:** existing `registerTool` calls, `requireOwned`, `ok`/`fail`
in `apps/server/src/mcp/server.ts`; token-lifecycle note
(`docs/solutions/2026-06-16-mcp-server-on-hono-and-token-lifecycle.md`).

**Test scenarios:**
- `begin_deploy` + `add_files` (chunked across 2 calls) + `finalize_deploy` →
  canvas published; works with text files sent as UTF-8 (no base64).
- `deploy_canvas({id, files:[...]})` inline → one-call publish for a small canvas;
  existing `zipBase64` path still works (regression).
- `deploy_canvas` with both `files` and `zipBase64`, or neither → stable error
  (no ambiguous precedence).
- a tool acting on a non-owned id → `not found` (no existence leak), all new tools.
- `add_files`/`finalize_deploy` for a canvas the caller doesn't own → not found.
- empty inline payload → guarded, not a throw.

---

### U7. Blob-GC live-set union + stale-session prune

**Goal:** Keep blob GC from sweeping blobs a pending finalize needs, and reclaim
abandoned sessions.

**Requirements:** Staging GC safety.
**Dependencies:** U1, U2.
**Files:** the blob-GC module (`apps/server/src/canvas/blob-gc.ts` per learnings),
`apps/server/src/db/repositories/upload-sessions.ts`. Schedule `deleteExpired`
**in the same place `engine.prune` / `collectGarbage` is already invoked** (the
existing per-canvas prune path), not a new job — C3.

**Approach:** Extend the GC live-set union (currently current-version manifest +
draft manifest) to include the **full target manifest** of **active, unexpired**
upload sessions for the canvas (`listActiveByCanvas`). The live set keys on the
session's *recorded manifest*, not on which blobs have physically landed — and
U2's `begin` writes that manifest up front, before any blob is staged. That
ordering is what closes the stage-then-record window (A2): GC's `storage.list()`
can never see a staged blob that isn't already covered by a recorded manifest
hash, because the hash is recorded at `begin`, strictly before the `put`. Keep the
existing "list storage before reading the live set" ordering. Never delete blobs
inline; stale sessions are reclaimed by the normal sweep once `deleteExpired`
removes the row.

**Patterns to follow:** `docs/solutions/2026-06-13-content-addressed-draft-publish.md`
(GC live-set), `docs/solutions/2026-06-13-purge-vs-deploy-race.md` (apply BOTH
cheap guards — the `markReady` one-row assert lands in U2; **here**, make `purge`
skip canvases soft-deleted within a window longer than the 15-min session TTL).

**Test scenarios:**
- A blob staged into an active session is NOT swept by GC even though no version
  references it yet.
- **Stage-then-record ordering:** GC running after `begin` recorded the manifest
  but before a blob is physically `put` still treats that hash as live (the
  recorded manifest covers it) — and a blob present in storage whose hash is in an
  active session's manifest is never swept.
- After a session expires and is pruned, its orphan blobs become eligible and are
  swept (when unreferenced by any live version/draft).
- A blob shared with the live version is never deleted while staging references it.
- `purge` of a canvas soft-deleted within the skip window does not run while a
  session for it could still finalize.

---

### U8. Docs update

**Goal:** Document the new upload flow on both surfaces.

**Requirements:** Discoverability; the origin's "no API key to paste" framing.
**Dependencies:** U5, U6.
**Files:** the docs source feeding `apps/server/src/docs/generated-content.ts`
(MCP server doc, Deploy API doc), and `/llms.txt`.

**Approach:** Document `begin_deploy`/`add_files`/`finalize_deploy`, the inline
`files` array, the keyed upload routes, and the manifest skip-unchanged behavior.
State the bytes-out-of-context property and that the handle is single-use and
short-lived.

**Test expectation:** none — documentation. Verify the generated-content build
step runs clean.

---

## Scope Boundaries

**In scope:** the staging/finalize spine, both channels over one service, the
`files` array adapter, manifest skip-unchanged, backward-compatible inline deploy,
auth re-validation, GC live-set safety, dual-dialect table + migrations, docs.

### Deferred to Follow-Up Work
- A resumable/multipart single-archive upload (vs per-blob PUTs) if blob counts
  make round trips costly in practice — measure first.
- Bounding the number of concurrent live sessions per canvas (a pathological burst
  could exhaust `createVersionWithRetry`'s attempt budget) — only if observed.
  (Both cheap purge guards from the race doc are now in-scope: `markReady` one-row
  assert in U2, purge soft-delete-skip window in U7.)

### Outside this product's identity (from origin)
- A sharing/visibility tool (`set_access` / public-link control) — real adjacent
  MCP gap, separate feature.
- A combined create+deploy convenience tool.
- **Presigned-S3 direct uploads** — rejected per KTD2 (breaks local storage,
  bypasses validation); revisit only as an S3-only optimization.

---

## Risks & Dependencies

- **Auth (P0).** The whole feature adds a credential surface. Mitigation: KTD5
  (hashed single-use handle, **idempotent** finalize, `assertUserActive` (both
  channels) + owner re-check on finalize, staging-time `callerId`/canvas-binding
  checks, block-after-issue tests). Run `/ce-code-review` before the PR; weight
  §12.0 hard-invariant findings as P0.
- **GC sweeping in-flight staged blobs.** Mitigation: U7 — `begin` records the
  manifest before any blob is staged, so the live-set union always covers a staged
  blob's hash (closes the stage-then-record window).
- **Purge vs long-lived staged finalize.** A 15-min staging window outlasts a
  deploy, widening the accepted purge-vs-deploy race
  (`docs/solutions/2026-06-13-purge-vs-deploy-race.md`). Both cheap guards are now
  in-scope deliverables: `markReady` asserts exactly one row (U2); `purge` skips
  canvases soft-deleted within a window > the session TTL (U7).
- **Resource safety on the chunked channel.** A pathological large/many-blob
  upload could pressure the VPS. Mitigation: per-blob 25 MB cap, the 100 MB /
  2000-file canvas caps enforced at finalize, per-account/per-canvas throttle.
  Trust-model-calibrated: accident defense, not hostile-insider hardening.
- **Dual-dialect drift.** Mitigation: U1 generates BOTH migrations and extends the
  parity test to the unique index + FK; the full suite (not just parity) is the
  catch.

---

## System-Wide Impact

- `McpToolDeps`/`McpRoutesDeps` and the Deploy-API deps gain a `storage`
  dependency — update the composition root (`apps/server/src/app.ts` `buildApp`,
  where these are constructed — not `index.ts`, which only calls `buildApp`) and
  any test harness that builds these.
- A new `DeploySource` literal (`"upload"`) — add it to `DeploySource` in
  `packages/shared/src/db/types.ts` **and** to the `versions_source_chk` CHECK
  constraint in both `schema.pg.ts` and `schema.sqlite.ts` (see U1); audit any
  exhaustive switch over `DeploySource`.
- New stable error codes in `deploy/errors.ts` — additive (agents repair from
  codes; never rename existing ones).

---

## Sources & Research

- Origin: `docs/brainstorms/2026-06-16-optimized-canvas-upload-requirements.md`
- `docs/solutions/2026-06-13-canvas-hosting-deploy-patterns.md` (source-agnostic
  `deploy()`, atomic-commit-on-swap, stable error codes)
- `docs/solutions/2026-06-13-content-addressed-draft-publish.md` (blob model,
  manifest-as-unit, GC live-set, never-delete-inline)
- `docs/solutions/2026-06-16-mcp-server-on-hono-and-token-lifecycle.md` (re-validate
  identity on use, hashed single-use credentials, base64 guard)
- `docs/solutions/2026-06-13-auth-invariant-checklist.md` (§12 modes: identity from
  server context, owner re-check / no existence leak, admin-not-a-bypass)
- `docs/solutions/2026-06-13-dual-dialect-drizzle-seam.md` (both schemas + both
  migrations + parity coverage of indexes/FKs)
- `docs/solutions/2026-06-13-ci-and-test-infra-gotchas.md` (`describe.each(DIALECTS)`,
  `mem` driver with `failOnPut`, MinIO env-gated smoke test)
- `docs/solutions/2026-06-13-purge-vs-deploy-race.md` (in-flight window)
- `docs/solutions/2026-06-16-admin-content-restriction-and-deploy-draft-sync.md`
  (owner-only seam for deploy/draft routes; post-deploy draft reconciliation)
