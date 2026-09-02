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

## If you are touching access next

1. Start from `decideCanvasAccess` and its test file; the hub, the shared-list service, settings-update, and the authoring API all follow it.
2. `isRestrictedRung` (`@canvas-drop/shared/db`) is the only place that knows the family; the dashboard has its own copy in `lib/api.ts` because it does not depend on the shared package.
3. Never key a capability on `specific_people` / `team` again — they are aliases. Guest AI is (correctly) keyed on the principal kind.
