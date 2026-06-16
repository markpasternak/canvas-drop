# Optimized canvas upload — requirements

**Date:** 2026-06-16
**Status:** Requirements (ready for `/ce-plan`)
**Scope tier:** Deep — feature (technical/architectural)

## Outcome

Deploying files to a canvas no longer forces the file bytes through the calling
agent's context window. The MCP surface carries only *intent*; bytes move over a
direct channel. Re-deploys of a mostly-unchanged canvas upload almost nothing.

## Problem

Today the only agent path to publish files is MCP `deploy_canvas(zipBase64)`
(`apps/server/src/mcp/server.ts`). The agent must zip its files, base64-encode
them, and pass the blob inline as a tool argument. That has three observed
failure modes, all hit in a real session:

1. **Context bloat** — the payload is read out of a shell command into the
   model's context and then re-emitted into the tool call, so every byte passes
   through the LLM twice.
2. **Silent corruption** — a single wrong character in a multi-KB base64 stream
   yields `INVALID_ZIP` (`invalid distance too far back`); the only recovery is
   re-encode-and-retry, which is what made a trivial deploy slow.
3. **No incremental path** — re-publishing a one-line change re-ships the whole
   payload.

The server already ingests more than a single blob: `apps/server/src/deploy/ingest.ts`
has `fromZip` and `fromPasteHtml`; the dashboard exposes `deploy/zip`,
`deploy/folder`, `deploy/paste` (`apps/server/src/routes/management.ts`); the
keyed Deploy API is `PUT /:id/deploy` (`apps/server/src/routes/deploy-api.ts`);
and storage is content-addressed (`apps/server/src/deploy/engine.ts`). The MCP
surface simply doesn't expose any of this beyond the inline zip.

## Users / actors

- **Shell-capable agents** (e.g. Claude Code) — can run `curl` / write a script,
  so they can transfer bytes directly over HTTP.
- **MCP-only agent hosts** (e.g. hosted clients with no shell) — can *only* call
  MCP tools; bytes must move through a tool-call mechanism.
- Both must be first-class. Design for the lowest common denominator **and** give
  shell agents the fast path.

## Goals / success criteria

- For a shell-capable agent, file bytes never enter the model context on deploy.
- A deploy cannot fail from a mangled inline blob in the common (text) case.
- A re-deploy that changes a small fraction of files uploads only the changed
  blobs.
- A small text-only canvas still deploys in a single call (no regression in
  ergonomics for the simple case).
- The same upload core backs both the MCP surface and the keyed Deploy API — no
  parallel logic.

## Chosen approach — staging/finalize spine (B) with content-addressed manifest (C) layered on

Introduce a **control-plane / data-plane split** with a shared staging→finalize
core, fed by two front-ends:

- **Begin** — an intent call returns a short-lived, owner+canvas-scoped upload
  handle (`uploadId`) and, for shell agents, a direct upload target.
- **Transfer (data plane)** — two interchangeable channels into the same staging
  area:
  - *Shell agents*: transfer the archive directly over HTTP (bytes bypass both
    the model and the MCP transport).
  - *MCP-only agents*: a chunkable tool call carrying `files: [{path, content,
    encoding}]` — **plain UTF-8 for text, base64 only for genuine binaries** —
    so the corruption-prone base64 path is avoided for the common case.
- **Finalize** — references the staged upload and publishes a version, reusing
  the existing deploy/publish service path and ownership checks.
- **Manifest (C, fast-follow)** — begin can accept a manifest of
  `[{path, sha256, size}]`; because storage is already content-addressed, the
  server replies with only the hashes it is **missing**, and the agent transfers
  only those blobs. Finalize assembles the version from the manifest.

**Backward compatibility:** `deploy_canvas` keeps an **inline** mode (today's
`zipBase64`, plus a new inline `files` array) for small/simple canvases, so the
trivial case stays a single call. Large/binary/shell deploys use the ticket.

### Why this over the alternatives

- **Files-array only (Approach A)** — smallest change, but large/binary payloads
  still pass through model context, so it fails the primary goal for shell
  agents. Kept as the *inline* mode for small canvases, not as the whole answer.
- **Spine without manifest (B only)** — fully solves both channels but re-ships
  unchanged bytes. Since the store is already content-addressed, C is an
  increment on B's protocol, not a second architecture — so it's worth layering
  rather than deferring indefinitely.

## Scope

### In scope
- Staging + finalize protocol over a shared ingest core.
- Exposure on **both** the MCP surface and the keyed Deploy API.
- `files` array ingest with per-file encoding (UTF-8 text / base64 binary).
- Content-addressed manifest negotiation (missing-hash reporting + partial
  upload).
- Backward-compatible single-call inline deploy for small canvases.

### Deferred / fast-follow
- Manifest/skip-unchanged (C) may ship as a fast-follow after the B spine lands,
  on the same protocol.

### Non-goals / outside this feature
- A sharing/visibility tool (`set_access` / public-link control) — a real,
  related gap (the MCP has no sharing tool today), but a separate feature.
- Combined create+deploy convenience tool — possible later ergonomics, not part
  of this.

## Constraints / assumptions (for planning to honor)

- **Auth invariant (§12.0):** the upload handle is scoped to the owner and a
  single canvas with a short TTL; **finalize re-checks ownership server-side**
  and never trusts a client-asserted identity. Direct-upload targets must not be
  guessable or reusable across canvases.
- **Audit:** finalize records the same audit event as existing deploys
  (`source` distinguishing channel).
- **Garbage collection:** abandoned staging uploads must expire and be reclaimed.
- **Assumption (unconfirmed):** staging blobs live in the same content-addressed
  store as published versions (unreferenced until finalize), not a separate
  bucket. Revisit in planning if it complicates GC or access control.
- **Dual-dialect / interface rules** apply unchanged: any new persistence goes
  through the existing repository/storage interfaces, kept in lockstep across
  SQLite/Postgres.

## Open questions

- Exact MCP tool shape: one polymorphic `deploy_canvas` (inline | uploadId) plus
  `begin_deploy` + `add_files`, vs. a small dedicated tool set. (Planning
  decision.)
- Whether the keyed Deploy API gains a parallel begin/finalize or reuses its
  existing `PUT /:id/deploy` with a manifest header. (Planning decision.)

## Handoff

Ready for `/ce-plan` to turn the chosen approach into units (begin/finalize core
→ MCP front-end → Deploy-API front-end → manifest layer), each with the auth and
GC constraints above as test scenarios.
