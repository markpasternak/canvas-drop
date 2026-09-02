# Restricted access model — the people-and-teams list always applies

**Date:** 2026-09-02 · **Plan:** `docs/plans/2026-09-02-0830-feat-restricted-access-model-plan.md` · **Issue:** #86 · **Follows:** editor roles (#82/#84), share-tab UX (#85)

## The problem we were solving

The Share tab had two controls that both answered "who can open this canvas?": the people-and-teams list (with viewer/editor roles) and the General access picker (five rungs). Only two rungs — `specific_people` and `team` — actually honoured the list for *viewers*, so the #85 intro sentence ("Everyone listed here can open the canvas, whatever General access below says") was true for editors and false for viewers. Adding a viewer to a private canvas silently did nothing.

## The decision

Google-Docs shape: **the list always applies; General access only widens.** Three choices — Restricted, Whole org, Public link. `specific_people` and `team` stay in the DB and the API as **legacy aliases of `private`** (no migration, no enum change); the dashboard displays all three as Restricted and only ever writes `private`.

## What changed, and the gotchas worth keeping

- **One predicate, two callers.** `decideCanvasAccess` checks `listed = isAllowed || (member && teamMatch)` *before* the rung switch; `resolveAccessContext` now runs the allowlist and team-match lookups at **every** rung for any principal that can be listed (a member, or the canvas's own guest). The realtime hub runs the same two lookups unconditionally. Parity tests pin both. When you add an access rule, add it to the decision table and let the hub call the table — never a second switch.
- **Public link too.** A listed person on a `public_link` canvas gets **full** access (primitives, realtime), not the static-only public view. The anonymous public is unchanged. Cost: two indexed point queries per signed-in request; anonymous traffic pays nothing (no lookup key).
- **Team grants belong to the list.** `resolveTeamGrant` lost its `clear` kind: a rung change never deletes team grants (the management route, MCP `update_canvas`, and the authoring API used to clear viewer teams when leaving `team`). The legacy `teamIds` field keeps replace semantics; an explicit `[]` is refused (`TEAM_REQUIRED`) rather than silently wiping — removals go through the people-list revoke path.
- **Discoverability is Whole-org-only now.** Direct grants always enumerated in Shared; team grants now do too. `discoverability` keeps its meaning for `whole_org` (Shared for the whole org + gallery eligibility) and settings-update pins every other rung to `link_only`. The Share-tab toggle became **List for your org**. Side effect worth knowing: a team share that had stayed `link_only` is now listed for its members.
- **Guards narrow to the two open rungs.** `SHARE_REQUIRES_PUBLISH` fires only for `whole_org` / `public_link`; moving within the restricted family opens nothing, so an unpublished canvas can carry its list. The gallery's `NOT_SHARED` covers the whole family.
- **Admin context ≠ rung.** The admin table's `context=team` now means "has at least one team grant" (an `exists` subquery), personal/org otherwise. Both list filters accept `access=restricted` (server expands to the family) — the dashboard's filter dropdown sends that value.
- **Behaviour changes to call out in review (the trust-model weighting):**
  - Viewers added to a `private` canvas before this round, never "activated" by a rung flip, can now open it. Intended.
  - An editor who leaves the org loses management at once (the editor predicate is org-scoped) but **keeps view access through their lingering direct row**, exactly like any invited outsider, until the owner removes the row. The old `private` rung merely masked the row. The org-departure scenario now pins this; if the product ever wants departure to end view access too, that is an allowlist-level org check, not a rung.
  - A demoted editor keeps a **viewer socket** (the list still admits them); removal drops it.

## Docs and marketing

The five-rung "access ladder" is gone from every surface (doc site, README, SECURITY.md, llms.txt, the skill, the landing page): the ladder visual now leads with the people-and-teams entry (accented) and lists Restricted / Whole org / Public link. Legacy API values are documented as aliases wherever an enum is shown. The docs-refresh workflow was **not** re-run for this round; `pnpm docs:build` + the docs integrity/route tests gated the hand edits.

## Audience and lifecycle are two fields (added mid-round)

The authoring API's derived `status` (`revoked › expired › private › live`) conflated two questions — *who else can open it* and *whether it is published* — and the fold made that visible: a `status: "private"` share with people on its list is published and reachable by them, and the legacy aliases read `live`. Rather than change a frozen field, the round added two additive ones derived by shared pure helpers:

- `accessModeOf(access)` → `restricted | whole_org | public_link` (`packages/shared/src/canvas/access-mode.ts`) — on the authoring, management and MCP projections.
- `publicationStatusOf({ status, hasCurrentVersion, revokedAt, sharedExpiresAt, now })` → `draft | published | expired | unpublished | archived | disabled | deleted` (`packages/shared/src/canvas/publication-status.ts`) — on the authoring projection; it refines the dashboard's coarser `publicationState` with revocation and expiry. Precedence: row lifecycle beats share facts, revocation beats the version, expiry only matters for something otherwise live.

`shareStatus` / `ShareStatus` stay exactly as they were (deprecated in JSDoc and docs). Consumers branch on the new fields. Lesson: when a derived field turns out to encode two concepts, add the two honest fields and freeze the old one — do not "fix" the old field's semantics under existing clients.

## Review lessons from this round

- **The list only widens.** The cross-model reviewer flagged a P0: a failed list lookup in the hub reads as "no match" and the rung then decides, so at `whole_org` a member keeps the socket through a DB failure. Validation rejected it — the list can only admit, never deny, so "no match" is the strictest possible value and the wide rung admits exactly whom it admitted before the round. The real defect was the comment claiming the code "fails closed". When a lookup can only widen access, a failed lookup is already the conservative outcome; say so in the comment and pin it with a test on both a restricted and a wide rung.
- **Grep the rung one more time.** Three reviewers independently found the clone path still keyed on `access === "team"`; the inventory `shared` counts, the authoring `requireExpiry` gate and `shareStatus` were the same class of leftover. After folding values into a family, grep every literal comparison against each member and route it through the family predicate or a deliberate decision.
- **Legacy request shapes deserve a carve-out, not an error.** Removing the `clear` kind made the old dashboard's "leave the Team rung" shape (`teamIds: []` with an `access` change) a `TEAM_REQUIRED` error. The compatible contract: that exact shape is a no-op (grants live on the list); a bare `[]` stays refused. The second review then caught the carve-out keyed on the *requested* value alone (an echoed `access: "private"` + `[]` was a silent no-op): key a compatibility carve-out on the real transition (`currentAccess === "team"` → something else), and keep the tool's describe text in the same sentence as the docs.
- **A widened branch inherits the narrower branch's holes.** Widening the clone path's team branch from `access === "team"` to every rung was correct — and exposed that the branch had never had the fences the gallery template path has. With no published version the clone service seeds from the owner's *draft*; the cloner owns the copy and so bypasses a password. Two reviewers found it independently. When a grant starts applying more widely, re-check what the grantee actually sees through the serve seam (published, unexpired, not password-gated) and fence the new path to that; `isCloneableByGrantedTeam` in `clone-service.ts` is the one predicate both surfaces now call.
- **Copy derived from an async list must know whether the list has loaded.** The Share tab's list-aware hints started from `[]`, so a not-yet-loaded or failed list read as "only you". Hold the mirror as `null` until the child reports a load, reset it on canvas change, and exclude entries that cannot open today (pending invites) from any "N people can open it" count.
- **Flags keyed on a renamed concept.** The dashboard's `canvas.shared` used to mean "not private"; the round redefined it as "open beyond the list", and two notices (password, expiry) silently became false for Restricted canvases with listed people. When a payload flag's meaning moves, grep the UI for every consumer, not just the tests.
- **Mid-tier review agents stall under low-priority sessions.** Every Sonnet-tier reviewer dispatch stalled at the 600 s watchdog while the session ran in low-priority mode; session-model retries completed. When that pattern appears, re-dispatch the critical lenses on the session model instead of retrying the same tier.

## If you are touching access next

1. Start from `decideCanvasAccess` and its test file; the hub, the shared-list service, settings-update, and the authoring API all follow it.
2. `isRestrictedRung` (`@canvas-drop/shared/db`) is the only place that knows the family; the dashboard has its own copy in `lib/api.ts` because it does not depend on the shared package.
3. Never key a capability on `specific_people` / `team` again — they are aliases. Guest AI is (correctly) keyed on the principal kind.
