---
title: "fix: Close the draft data-loss cluster (unmount-flush race + restore confirm-gate)"
status: active
date: 2026-06-14
type: fix
origin: ce-code-review run 20260614-140831-584b0247 (adversarial.json findings A1/#2, A2/#9)
---

# fix: Close the draft data-loss cluster

## Summary

Two adversarial findings from the editor-polish review are the same family — the editor's draft autosave can lose work around a **restore-to-draft**:

- **#2 (A1)** — the unmount autosave-flush (`canvas.editor.tsx`) fires `api.putDraftFile` directly (outside the `draft-${id}` serialization scope). If it lands *after* a restore, the stale single-file PUT re-writes one path of the restored version — silent partial clobber.
- **#9 (A2)** — `requestRestore` (`canvas.versions.tsx`) skips its destructive-action confirm when `draft.dirty` is false, but the server `dirty` flag lags edits still sitting in the autosave debounce window, so in-window work is discarded without warning.

The fix conditions draft-file writes on the draft's existing **`baseVersionId`** fork-point token (changed by `restore`, untouched by incremental autosave) so a stale flush is rejected with `409`; and surfaces in-flight editor edits into the draft's dirtiness so the restore confirm-gate fires. No schema change, no migration.

---

## Problem Frame

The content-addressed draft model (M5) stores one mutable draft per canvas; every draft-file write is a server-side full-manifest read-modify-write, and `restore` replaces the draft wholesale and re-points its `baseVersionId` at the restored version. The client serializes normal autosaves via the TanStack `scope: { id: draft-${id} }`, **but the unmount-flush bypasses that scope** (the mutation is torn down on unmount, so it calls `api.putDraftFile` directly). Restore is a separate, unscoped mutation. Nothing orders the stale flush against the restore, and nothing tells the restore decision that the editor still holds unsaved edits.

**Trust model:** single-owner draft, authenticated org member. This is a correctness/data-integrity fix, not a hostile-input surface. Concurrent **multi-tab** editing of the same draft remains a separate, acknowledged residual risk (out of scope here).

---

## Requirements

- **R1** — A draft-file write that is based on a draft state superseded by a `restore` (or any wholesale replacement) must NOT silently overwrite the restored content. It must be rejected and surfaced (the existing flush `console.warn` is acceptable surfacing).
- **R2** — Normal sequential autosaves (no intervening restore) must continue to succeed unconditionally — the precondition must not reject ordinary incremental saves.
- **R3** — Restoring a version while the editor holds unsaved in-window edits (debounce not yet fired / flush in flight) must trigger the destructive-restore confirmation, not proceed silently.
- **R4** — No schema/migration change; reuse the existing `baseVersionId` already exposed on the draft view.

---

## Key Technical Decisions

- **KTD-1 — Concurrency token = `baseVersionId`, not a per-write etag or `updatedAt`.** `updatedAt` changes on *every* autosave, so an `If-Match: updatedAt` precondition would reject normal sequential saves (violates R2). `baseVersionId` changes only on wholesale replacement (`restore`), which is exactly the clobber cause the review identified. It is already on `DraftView` (`api.ts:136`) and the server `Draft` row, so no new state. The precondition is **opt-in** (only sent when the client wants conflict protection — i.e., the unmount-flush), so all other write paths are unaffected.
- **KTD-2 — Enforce server-side, fail closed with `409`.** The header is advisory from the client but authoritative on the server: if `If-Draft-Base` is present and differs from the draft's current `baseVersionId`, the PUT returns `409` and writes nothing. Client-only ordering can't be trusted across an unmounted component; the server is the serialization point.
- **KTD-3 — #9 fix = optimistic draft-dirty on unmount-flush, not a cross-component store.** The only path from "editor with in-window edits" to `requestRestore` is navigating editor→versions, which unmounts the editor and runs the flush branch. Marking the shared draft cache `dirty: true` at that moment (then reconciling via invalidate when the flush settles) makes the versions route's existing `draft.dirty` check fire the confirm — no new shared-state primitive, minimal blast radius (avoids flipping `dirty` on every keystroke, which would touch PublishBar during editing).
- **KTD-4 — `409` on the flush is a no-op for the user.** The unmount-flush is best-effort and already swallows+warns on failure (added in the prior review pass). A rejected stale flush is the correct outcome: the user chose to restore; their superseded buffer should not resurrect. The `console.warn` documents it for debugging.

---

## High-Level Technical Design

The race today (partial clobber) vs. after the precondition (stale flush refused):

```
BEFORE (#2):
  editor unmount ──PUT /draft/file (stale, no precondition)──┐
                                                              ▼
  versions: restore v3 ──POST /restore──► draft = v3      [server applies restore]
                                                              ▼
                              stale PUT lands ──► draft[path] := stale buffer  ✗ clobbers one file of v3

AFTER (#2 fixed):
  editor unmount ──PUT /draft/file  (If-Draft-Base: <base@load>)──┐
  versions: restore v3 ──► draft.baseVersionId := v3.id            ▼
                              stale PUT lands ──► base mismatch ──► 409, no write  ✓ v3 intact
                                                                  └─► client .catch → console.warn

#9 confirm-gate:
  editor unmount with dirty buffer ──► qc.setQueryData(draft, dirty:true) ──► flush (fire+reconcile)
  versions mount ──► requestRestore() sees draft.dirty === true ──► destructive confirm dialog ✓
```

---

## Implementation Units

### U1. Server + client optimistic-concurrency on the draft-file PUT (`If-Draft-Base`)

**Goal:** A draft-file write carrying a stale `baseVersionId` precondition is rejected with `409` instead of clobbering restored content. Fixes #2 (A1).
**Requirements:** R1, R2, R4.
**Dependencies:** none.
**Files:**
- `apps/server/src/routes/draft-api.ts` — read an optional `If-Draft-Base` header in the `PUT /:id/draft/file` handler; before writing, compare to the loaded canvas's current draft `baseVersionId`; on mismatch return `409 { code: "DRAFT_CONFLICT", message: ... }` and do not write. (Use the draft the service is about to mutate as the source of truth for the current base — read it via the existing `drafts.getOrCreate`/equivalent rather than trusting the client.)
- `apps/dashboard/src/lib/api.ts` — `putDraftFile` gains an optional `expectedBaseVersionId?: string | null`; when provided, send it as the `If-Draft-Base` request header. Keep the existing `signal` param.
- `apps/dashboard/src/routes/canvas.editor.tsx` — track the loaded draft's `baseVersionId` in a ref (updated on file load and on successful autosave, alongside `loadedRef`); pass it as `expectedBaseVersionId` on the **unmount-flush** call only. The existing `.catch`→`console.warn` already surfaces the `409`.
- `apps/server/src/routes/draft-api.test.ts` (or the nearest existing draft-api test file) — server-side precondition tests.

**Approach:** The precondition is opt-in: only the unmount-flush sends `If-Draft-Base`. Normal scoped autosaves, uploads, creates, renames send nothing and are unaffected (R2). Server logic: in `PUT /:id/draft/file`, if the header is present, resolve the current draft and reject with `409` when `header !== draft.baseVersionId`; otherwise proceed exactly as today. `baseVersionId` is `string | null` — treat a missing/absent header as "no precondition" (do not conflate with a `null` base).

**Patterns to follow:** mirror the existing `deployErr` / stable-error-shape handling and the `viewOf` response in `draft-api.ts`; mirror header-passing style in `api.ts`’s existing fetch wrappers.

**Test scenarios:**
- Covers R1. PUT with `If-Draft-Base` equal to the draft's current `baseVersionId` → write applies, returns the updated draft view (200).
- Covers R1. PUT with `If-Draft-Base` that does NOT match the current `baseVersionId` (simulate a restore having moved the base) → `409`, response carries `DRAFT_CONFLICT`, and the file on disk/manifest is unchanged (assert the path still has the post-restore content, not the stale body).
- Covers R2. PUT with **no** `If-Draft-Base` header → upsert applies as today (back-compat for autosave/upload/create paths).
- Edge: `If-Draft-Base` present while the draft's `baseVersionId` is `null` (draft forked from no live version) and header is a non-null string → `409` (mismatch), no write.
- Client: `putDraftFile(id, path, body, { expectedBaseVersionId })` sets the `If-Draft-Base` header; called without it sends no such header (assert via fetch mock).

**Verification:** server tests prove apply-vs-409 both ways and that a mismatched precondition leaves the manifest untouched; a restore-then-stale-flush sequence no longer mutates the restored file.

---

### U2. Surface in-flight editor edits to the restore confirm-gate

**Goal:** Restoring a version while the editor holds unsaved in-window edits triggers the destructive-restore confirmation. Fixes #9 (A2).
**Requirements:** R3.
**Dependencies:** none (independent of U1; ship together).
**Files:**
- `apps/dashboard/src/routes/canvas.editor.tsx` — in the unmount-flush branch (when `dirtyRef.current && bufferPathRef.current !== null`), optimistically mark the cached draft dirty (`qc.setQueryData(keys.draft(id), d => d ? { ...d, dirty: true } : d)`) **before** firing the flush, and invalidate `keys.draft(id)` when the flush settles (in both `.then` and `.catch`) so the authoritative server `dirty` reconciles.
- `apps/dashboard/src/routes/canvas.versions.tsx` — no logic change required if the existing `draft?.dirty` check is the gate; confirm it reads the same `keys.draft(id)` cache. (If a stale `draft` snapshot is a concern, ensure the versions route's draft query is not `staleTime`-frozen past the flush.)
- `apps/dashboard/src/test/editor.test.tsx` and `apps/dashboard/src/test/versions.test.tsx` — coverage.

**Approach:** The editor→versions navigation unmounts the editor and runs the flush branch; setting the shared draft cache `dirty: true` there makes the versions route's existing `requestRestore` (`if (draft?.dirty) confirm; else restore`) fire the confirm for in-window edits. Reconcile on flush-settle so a clean draft doesn't stay falsely dirty. Keep the optimistic flip scoped to the unmount path — do **not** flip dirty on every keystroke (avoids churn in PublishBar during active editing).

**Patterns to follow:** existing `qc.setQueryData(keys.draft(id), …)` usage in `mutations.ts` (`useSaveDraftFile.onSuccess`); the destructive-confirm pattern already in `canvas.versions.tsx` (`restoreTarget` + ConfirmDialog).

**Test scenarios:**
- Covers R3. Editor with a pending unsaved buffer (dirty, debounce not fired) unmounts → cached draft becomes `dirty: true`; navigating to versions and invoking restore shows the destructive ConfirmDialog (no restore call until confirmed).
- Clean draft (no pending edits) unmounts → cached draft dirtiness unchanged; restore on a clean/matches-live draft proceeds straight away (no regression to the fast path).
- After the flush settles, `keys.draft(id)` is invalidated so a subsequent read reflects server-authoritative `dirty` (assert invalidate fires on both success and failure of the flush).

**Verification:** the versions route confirms before discarding in-window edits; the clean-draft fast path is preserved.

---

## Scope Boundaries

**In scope:** the restore-vs-flush partial-clobber (#2) and the lagging restore confirm-gate (#9).

### Deferred to Follow-Up Work
- **Concurrent multi-tab draft writes** — two editor tabs on the same canvas still have no last-writer detection (acknowledged review residual). The `If-Draft-Base` precondition could be generalized to all writes to address this, but that changes the normal autosave path and needs its own design (per-file hash precondition or a monotonically-increasing draft revision). Not in this fix.
- **`processTouchesWorktree` / test-runner robustness** and the other acknowledged advisory items from the same review — unrelated.

---

## Risks & Dependencies

- **Risk: the precondition rejects legitimate saves (R2 regression).** Mitigated by KTD-1 (token changes only on wholesale replace) + the opt-in design (only the flush sends it) + the explicit no-header back-compat test.
- **Risk: optimistic `dirty` flip causes UX churn** (e.g., PublishBar enabling early). Mitigated by KTD-3 — the flip happens only on unmount, not per keystroke, and reconciles on flush-settle.
- **No external dependencies, no migration, no config change.** Dual-dialect unaffected (no schema touch).

---

## Verification (whole change)

- `pnpm typecheck` clean.
- New server precondition tests + editor/versions tests green via the project runner (`node scripts/test-runner.mjs file <paths>`).
- `pnpm lint` clean.
- Manual reasoning trace: restore-then-stale-flush leaves the restored file intact (409); restore with in-window edits prompts confirm.
