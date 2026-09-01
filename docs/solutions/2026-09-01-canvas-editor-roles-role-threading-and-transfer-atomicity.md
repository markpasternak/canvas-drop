---
title: Canvas editor roles — one resolver behind every gate, transfer atomicity, and the concurrency bugs the review caught
type: architecture
area: [auth, data, realtime, dashboard]
date: 2026-09-01
---

The editor-roles round (`docs/plans/2026-09-01-1909-feat-canvas-editor-roles-plan.md`,
issue #82) added a viewer/editor role to every canvas's people list and made "owner or
editor" the management-surface principal. Twelve units, ~11k executable lines, green on
both dialects, and the 13-lens `/ce-code-review` (plus an independent Codex pass) still
found six P1s. Read this before touching roles, the draft manifest, or socket re-auth.
See also [[auth-invariant-checklist]] and [[teams-parity-shared-helpers-and-listforuser]].

## What held up (do it this way again)

1. **One role resolver, called by every gate.** `apps/server/src/canvas/role.ts`
   (`resolveManagementRole` / `resolveManagementGrant` / `loadManagementGrant`) replaced the
   seven scattered `ownerId ===` checks. `isOwnerOf` is the only owner comparison outside the
   pure view-access decision table. Check order is fixed and tested: role -> owner-only act ->
   disabled. A no-role caller reads the canvas as not found on HTTP, MCP, and the socket.
2. **The MCP surface is table-driven.** `mcp/tool-roles.ts` declares every canvas tool's
   minimum role once; an inventory test fails on any tool registered without a row, and a
   role-matrix test drives every tool as owner / editor / viewer / stranger over BOTH transports
   and asserts the same refusal (`OWNER_ONLY`, `NOT_ACTIVE`, not-found). This is what made the
   double-archive "canvas not found" bug visible before review.
3. **Editor grants are live, not cached.** `editedByPredicate` (one SQL predicate) backs the
   resolver, the owned-or-edited list, the summary counts, the tag facets, and the Shared
   exclusion, so every surface agrees. Under an org boundary the predicate re-joins live org
   membership per request; there is no reconcile job.
4. **Transfer is a composite repository write.** `transferOwner` does a conditional
   `UPDATE ... WHERE owner_id = :from RETURNING` (a lost race reads as `TransferConflict`), the
   previous owner's editor row, the public-link revert, and the key rotation in one call. On
   Postgres it is a real transaction; on SQLite `inTransaction` is a passthrough, so the write
   ORDER is the safety net and the conditional swap is what makes a race safe.

## What the review caught (the traps)

1. **Per-file preconditions did not make the manifest write safe.** Every draft mutation
   read the whole manifest, checked ONE path, and wrote the whole manifest back
   unconditionally. Two editors saving different files in the same window both passed their
   precondition and the last write dropped the first entry. **Fix:** `drafts.setManifest` and
   `resetToBase` take the row's `updatedAt` and compare-and-swap on it; the service wraps
   mutations in a read-merge-retry loop (`commitManifest`) that re-runs the precondition on the
   fresh manifest, so a disjoint-path change merges and a same-path change refuses. Publish and
   deploy skip their post-publish reset when the draft moved on instead of erasing the save.
   *Lesson:* a precondition on an entry is not a precondition on the document that holds it.
2. **The client's hash bookkeeping lagged the server.** The dashboard refreshed its per-file
   hash map in an effect (a macrotask after the save resolved), so a rename or delete right
   after a save carried the pre-save hash; overlapping flush triggers captured a stale hash and
   self-conflicted; uploads, replace, and on-page save sent no hash at all and were refused
   whenever another user had written the file last. **Fix:** track hashes synchronously from
   every mutation response, one save in flight at a time (later callers chain and re-read), and
   every write path carries the hash. *Lesson:* when the server gains a precondition, audit
   every client write path for it, not just the one that motivated it.
3. **Handshake-time org membership on sockets.** HTTP and MCP rebuild the caller's org set
   per request; the realtime hub kept the set captured at connect, so a departed org member's
   editor (or whole_org / team) socket survived every heartbeat sweep. **Fix:** the hub takes a
   live `resolveOrgIds` and refreshes each member connection's set per sweep, failing closed on
   resolver errors. *Lesson:* "re-check on every use" ([[mcp-server-on-hono-and-token-lifecycle]])
   applies to every input of the decision, not just the grant row.
4. **A conditional update whose result nobody read.** Setting a pending invite's role was a
   conditional `UPDATE ... WHERE consumed_at IS NULL` that returned nothing when login
   materialization had already consumed the invite; the service reported and audited success
   anyway, and the materializer's snapshot of the old role won the race. **Fix:** honour the
   null result (not found), and consume role-aware (`consumeIfRole`) with a re-read-and-re-apply
   when the role changed underneath. *Lesson:* a conditional write is only as safe as the check
   of its row count.
5. **An omitted argument that defaulted to a downgrade.** Both team-grant callers defaulted an
   omitted `role` to viewer and the write was unconditional, so re-adding an editor team
   demoted it — while the person path (and the tool description) promised "omitted never
   changes an existing entry". **Fix:** resolve the role from the existing grant and report
   `granted` / `role_changed` / `already_added`. *Lesson:* when two sibling paths share a
   contract, test the contract on both.
6. **UI truthfulness.** The transfer picker only offered direct member editors (never the
   people behind an editor team the service would accept); the plan's "regenerate the deploy
   key?" prompt after removing an editor (KTD11 / AE19) was never built; a team scope badge was
   derived from the actor's own team list. The server now projects owner-only
   `transferCandidates`, the prompt exists, and team rows carry `teamOrgId`.

## Process notes

- Weight review findings against the trust model ([[auth-invariant-checklist]]): the socket
  org-staleness and the invite race were rated P0 by the cross-model peer; in a trusted-org
  product with the pre-existing whole_org pattern they are P1 — real, fixed, but not
  exploitable-by-hostile-user. Calibrate, then fix anyway.
- The manual browser walk found two things the tests did not: the grid card showed no owner
  marker (only the list row did), and the people list kept pre-transfer rows after a transfer
  (a component-local fetch that nothing invalidated). Walk the flows.
- Driving a Downshift combobox with automation drops keystrokes (the controlled `inputValue`
  is applied in a passive effect); dispatch one synthetic input event with the whole value
  instead. Human typing is unaffected.
