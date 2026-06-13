---
date: 2026-06-13
topic: build-resequence-editor-version-model
---

# Build resequence + editor / draft-publish version model

## Summary

Resequence the canvas-drop build to match the direction it actually took after dashboard core, and define the next milestone: an in-browser file manager + code editor backed by a **draft / explicit-publish** version model on **content-addressed storage**. `BUILD_BRIEF.md` is updated to reflect both the work already shipped and the new ordering.

## Problem Frame

The brief's §16 sequence was Foundation → Hosting+Deploy → Dashboard core → Primitives (KV/files/me/realtime/SDK) → AI+usage → Admin+hardening+packaging. Foundation, Hosting+Deploy, and Dashboard core all merged (#1/#3, #4/#5, #7).

Then the work deviated. Instead of starting the primitives, every commit since #7 deepened *canvas management*: archive/unarchive (a `[v1.1]` item), soft-delete purge with file/version reclaim, deploy-a-new-version from the UI, a settings-page redesign with section nav, password reveal/copy, theme-aware password gate, list/overview stats (size, file count, deploy method), and storage/DB perf passes. This is coherent — it's the 80% loop (host + iterate) and it's the dashboard that "sells the repo" (§14.4) — but the brief never sanctioned it, so several `[v1.1]` items are silently done and no milestone names "make managing a canvas excellent."

The natural next step on that thread is the in-browser editor (§6.2.4/5, `[v1.1]`). But the brief specifies "save = new version," which produces version explosion: every keystroke-save becoming an immutable, storage-duplicating version. And the deeper trap underneath it — confirmed by reading the deploy engine — is that storage is keyed per version (`versions/{versionId}/{path}`), so today *every* version is a full copy of all its files, with no deduplication, even though a sha256 per file is already computed for the manifest. An editor on top of that model is both noisy (too many versions) and wasteful (every version copies everything).

## Key Decisions

- **Draft + published-versions model.** Each canvas has one mutable draft (a working set of files). The in-browser editor and file manager change the draft, autosaved, creating no version. An explicit **Publish** snapshots the draft into a new immutable version and swaps the live pointer. Editing an old version is done by **restoring it into the draft** (never editing an immutable version in place), then republishing. The live URL always serves the latest published version; the draft has its own preview.

- **Content-addressed storage is the foundation.** Blobs are keyed by content hash (`blobs/{sha256}`) instead of by version+path. A version and the draft are then both just *manifests* (`path → hash`), so they cost a row, not a file copy. Editing one file writes at most one new blob; unchanged files keep referencing their existing blobs. "Restore old version to draft" and "Publish" both become manifest operations — effectively instant. Pruning must refcount/mark-sweep blobs rather than blind-delete a version's prefix.

- **Greenfield — no migration.** All existing data can be cleared. The content-addressed change is built from scratch; there is no re-keying of already-shipped versions and no backfill. (Versioned-release migration safety remains a post-v1 concern, per the brief.)

- **Agents and uploads still publish directly.** The deploy API (`PUT .../deploy`) and dashboard folder/ZIP re-upload create + publish an immutable version immediately, unchanged from today — preserving the "deploy = live" agent contract (§4.5). The draft + explicit-publish loop is exclusive to the in-browser editor. Concurrency is last-publish-wins: if an agent publishes while a human holds an unpublished draft, the draft simply goes stale and the UI shows a soft "a newer version was published" notice — no locking, no merge.

- **New milestone order.** Editor/version-model → Primitives (KV, files, `me()`, SDK) → Admin + hardening → Gallery → AI proxy + realtime → deployment/backup/load-test/OSS-packaging **last**. Rationale: primitives create the new canvas-facing API surface, so hardening lands after the real thing exists; gallery needs apps worth surfacing; AI and websocket are explicitly deferrable; deployment/ops hardening pairs naturally as the closing milestone.

## Requirements

**Roadmap & brief reconciliation**

- R1. `BUILD_BRIEF.md` is updated so the documented sequence matches reality: the post-dashboard-core canvas-management work is recorded as a recognized, completed milestone rather than an unplanned drift.
- R2. Feature-inventory tags are corrected for work already shipped — at minimum Archive canvas (§6.1.15) flips from `[v1.1]` to done; any other inventory item completed in the polish round is re-tagged.
- R3. §16 (build sequence) is rewritten to the new order: Editor/version-model → Primitives → Admin+hardening → Gallery → AI+realtime → deployment/backup/load-test/packaging last.
- R4. D11 (Versioning) and §6.2.4/6.2.5 are revised from "save = new version" to the draft / explicit-publish model; the immutable-versions + keep-last-10 + rollback guarantees are retained, now expressed as the *published* tier.
- R5. The five-primitives contract, the security invariants (§12.0), and the dual-dialect rule are unchanged by this resequence — only ordering and the version/editor model move.

**Next milestone — content-addressed storage**

- R6. Canvas file blobs are stored content-addressed by hash; identical content across versions/drafts is stored once.
- R7. A version is represented as a manifest mapping path → content-hash (plus per-file size/mime), not as an independent copy of bytes.
- R8. Pruning beyond the kept versions deletes only blobs no surviving version or draft references (refcount or mark-sweep); a blob still referenced is never deleted.
- R9. Canvas serving resolves the live version's manifest and streams blobs by hash, preserving current caching semantics (HTML/stable paths `no-cache`+ETag; content-addressed assets immutable-cacheable).

**Next milestone — draft / publish**

- R10. Each canvas has exactly one mutable draft, derived from a base (the current live version, or empty for a brand-new canvas).
- R11. Editor and file-manager mutations write to the draft and autosave; no version is created by editing.
- R12. An explicit Publish action freezes the draft's current manifest into a new immutable published version and atomically swaps the live pointer.
- R13. A draft is previewable by the owner without being published (preview is not the public live URL).
- R14. Restoring a published version copies that version's manifest into the draft, replacing the draft's contents, ready to edit and republish.
- R15. Deploy API and folder/ZIP re-upload publish a live version directly (no draft step); if an unpublished draft exists, it is preserved and flagged stale rather than overwritten or auto-merged.

**Next milestone — in-browser editor & file manager**

- R16. File manager over the draft: tree view, add, rename, delete, replace (§6.2.4).
- R17. CodeMirror 6 editor over draft files with save-to-draft (§6.2.5), syntax-aware for common web file types.
- R18. The editor/manager surfaces draft state clearly: unpublished-changes indicator, Publish affordance, and the stale-draft notice when a newer version was published underneath it.

## Key Flows

- F1. **Edit and publish.** Owner opens a canvas → file manager/editor loads the draft → edits files (autosaved to draft, no version) → previews the draft → clicks Publish → a new immutable version is created and goes live → version history shows the new published version.

- F2. **Edit an old version.** Owner opens version history → picks an older published version → "Restore to draft" copies its manifest into the draft → edits → Publish creates a new version (history is append-only; the old version stays immutable).

- F3. **Agent publishes under a human draft.** Owner has an unpublished draft → an agent `PUT .../deploy` (or a folder re-upload) publishes a new live version directly → the draft is kept but marked stale → the editor shows a "newer version was published" notice; publishing the draft proceeds last-publish-wins.

## Acceptance Examples

- AE1. **Covers R6, R11.** Given a canvas whose live version has 20 files, when the owner edits one file in the draft, then exactly one new blob is written and the other 19 files reference their existing blobs.
- AE2. **Covers R11, R12.** Given an editor session with several saved edits to the draft, when the owner has not pressed Publish, then no new version exists and the live URL still serves the prior published version.
- AE3. **Covers R12, R14.** Given the owner restores version 2 into the draft and publishes, when the publish completes, then a new version (e.g. v4) is created from v2's contents and v2 itself remains unchanged and immutable.
- AE4. **Covers R8.** Given pruning removes an old version, when a blob from that version is still referenced by a surviving version or the draft, then that blob is retained.
- AE5. **Covers R15.** Given an owner with an unpublished draft, when an agent deploys via the API, then the agent's version goes live immediately and the owner's draft remains intact and is shown as stale.

## Scope Boundaries

**This (next) milestone**
- In scope: content-addressed storage, draft/publish version model, in-browser file manager + CodeMirror editor, brief reconciliation, the §16 rewrite.

**Deferred for later (sequenced after this milestone)**
- Primitives: KV (shared/user/increment), files, `me()`, browser SDK.
- Admin panel + security/ops hardening (rate limits, headers, audit completeness, takedown/restore).
- Gallery (opt-in browse/listing).
- AI proxy (streaming/allowlist/quotas/metering) and realtime/websocket (pub/sub + presence).
- Deployment hardening **last**: Docker image/compose, deploy docs, backup/restore drill, load testing, security review, OSS packaging.

**Outside this milestone's identity**
- No branching/merging of drafts, no multi-draft per canvas, no collaborative/locked editing — last-publish-wins is the deliberate concurrency model at D13 scale.
- No build step server-side (static-first, §4.3) — the editor edits static files, it does not compile.

## Dependencies / Assumptions

- Greenfield: all data is clearable, so the storage re-keying needs no migration ([[greenfield-data-clearable]]).
- The deploy engine already computes a sha256 per file for the manifest, so content-addressing reuses an existing value rather than introducing new hashing.
- Trust model unchanged: owner-scoped editing, no new cross-canvas surface introduced by drafts ([[trust-model-calibration]]).
- Dual-dialect schema discipline applies to any new draft/blob-reference tables.

## Outstanding Questions

**Deferred to planning**
- Whether the draft is modeled as a dedicated table/entity or as a version row with a `draft` status, and exactly how blob refcounting is implemented (counter vs mark-sweep). Both are interior implementation choices for `ce-plan`.
- Draft preview URL shape (e.g. a preview path/param) within the existing URL-mode router.
- Whether the version cap (keep-last-10) counts only published versions (assumed yes) and whether autosave keeps any in-draft history for undo (nice-to-have, not required by R-IDs).
