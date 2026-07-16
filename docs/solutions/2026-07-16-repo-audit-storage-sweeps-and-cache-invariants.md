# Repo audit round: storage sweeps, per-file cache invariants, and dialect-safe prefixes

Learnings from the 2026-07-16 full-repo audit (deps + bug/security/usability sweep).
Each of these survived green tests until a reviewer traced the path end-to-end.

## 1. A "reclaim everything" sweep must enumerate every storage prefix explicitly

Purge deleted `canvases/{id}/blobs/` + `screenshots/{id}/` but the Files-primitive
uploads live under a third prefix, `files/{id}/` (up to 1 GB/canvas), with rows in
`files` + `kv_entries` — none of which purge touched, and the blob GC is scoped to
the blob prefix, so nothing ever swept them. **When adding a storage prefix or a
per-canvas table, grep `purge.ts` and add it to the sweep in the same PR.** The
prefix helpers now live together in `canvas/storage-keys.ts` (`canvasFilesPrefix`)
so purge and the writer can't drift.

## 2. React Query: a per-item content cache is only correct if EVERY writer goes through it

The editor caches draft file content under `keys.draftFile(id, path)`. Autosave
updated the server and the draft manifest cache but never this key — so switching
files and back re-seeded CodeMirror with pre-edit content, and the next autosave
**overwrote the saved edits with the stale document** (silent data loss). The fix
is a write-through in `useSaveDraftFile.onSuccess` plus `removeQueries` in every
mutation that changes file content out-of-band (upload, delete, rename, restore).
**Rule: when introducing a `["thing", id, subKey]` cache, put the key in
`lib/queries.ts` `keys` and audit every mutation that can change that data — an
invalidation added "where it broke" (the on-page editor got one; autosave didn't)
is the smell that the invariant isn't centralized.**

## 3. Key-range prefix filters are not dialect-safe; use escaped LIKE

`[prefix, prefix + '￿')` drops any key whose next char is astral (emoji) on
SQLite's byte collation, and Postgres locale collations order the bounds
differently anyway. `LIKE 'prefix%' ESCAPE '\'` (escaping `\%_`) is
collation-independent and identical on both dialects.

## 4. `Json | null` return types can't represent existence — and NOT NULL columns decide the contract

`kv.get` returning `Json | null` can't distinguish "absent" from "stored null".
It turned out `kv_entries.value` is NOT NULL, so a JSON `null` PUT was 500ing on
the DB constraint. The contract is now explicit: JSON `null` is rejected at the
route (400) because `null` is the SDK's absent-key sentinel; the repo gained a
row-aware `find()` for existence checks (key quota, GET 404). **When a route
accepts "any JSON", check what the column actually allows and pin the edge in a
test.**

## 5. Synthetic principals must be excluded from user-table liveness checks

Realtime revalidation ran `isUserActive(conn.user.id)` for every socket, but a
guest's id is the synthetic `guest:<inviteId>` — never in `users` — so every
legacy-guest socket flapped (dropped "user inactive" each sweep, reconnect,
repeat). Liveness checks against the users table must be gated on
`principal.kind === "member"`; guest liveness is the allowlist re-check. **When a
check takes a user id, ask which principal kinds can reach it.**

## 6. Delete-then-insert "replace set" writes need the tx helper

`setCanvasTeams` was delete + insert as two statements; a failure in between
leaves a `team`-rung canvas granted to nobody. The repos already have a
dual-dialect `tx()` helper — use it for every replace-set write.

## 7. Dependency-audit overrides (pnpm-workspace.yaml)

Both `pnpm audit` findings were transitive dev-only esbuild advisories (via
drizzle-kit's deprecated `@esbuild-kit` loader and vitest→vite). Fixed with
scoped `overrides` in `pnpm-workspace.yaml` rather than waiting on upstreams:
`"esbuild@<=0.24.2": "^0.25.12"` and `"esbuild@>=0.27.3 <0.28.1": "^0.28.1"`.
drizzle-kit generate verified working after the override. Biome 2.4→2.5 needs
`biome migrate` + a formatter pass; its new `noUnsafeOptionalChaining` rule is
worth keeping (it flagged real would-throw expressions in tests).
