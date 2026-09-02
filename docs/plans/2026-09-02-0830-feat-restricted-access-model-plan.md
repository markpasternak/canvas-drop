---
title: "feat: Restricted access model — the people-and-teams list always applies"
type: feat
status: active
date: 2026-09-02
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
origin: share-tab UX follow-up to canvas editor roles (#82 / #84 / #85); decision taken with Mark 2026-09-02 ("Restricted model"); tracking issue #86
---

# feat: Restricted access model

## Goal Capsule

Make the Share tab say one true thing: **everyone you add under "Share with people and teams" can open the canvas, whatever General access says.** General access shrinks to three honest choices — **Restricted** (only the people and teams above; with nobody added, just you), **Whole org**, **Public link** — and the two rungs that duplicated the list (**Specific people**, **Team**) fold into Restricted. The API keeps all five rung values for compatibility; the server treats `private`, `specific_people` and `team` as one family and honours viewer and viewer-team grants at every rung.

---

## Product Contract

### Summary

Today the Share tab has two places that both decide who can open a canvas: the people-and-teams list (roles) and the General access picker (rungs), and the picker's `specific_people` / `team` rungs are the *only* rungs at which listed viewers and viewer teams are actually admitted. That is why the #85 intro sentence ("Everyone listed here can open the canvas, whatever General access below says") is true for editors but false for viewers: a viewer added while the rung is `private` cannot open the canvas until the owner *also* flips the rung to Specific people. This round removes the contradiction by making the list authoritative and the picker purely about "who *else*".

### Problem Frame

- Two controls answer the same question ("who can open this?") and disagree.
- `specific_people` and `team` are rungs whose only meaning is "consult the list" — a mode switch on a list that should always count.
- Adding a viewer at `private` silently does nothing for that viewer (no error, no hint). Support-shaped bug.
- The pattern people already know (Google Docs/Drive) is: a list that always applies, plus a general-access dropdown with Restricted / Organisation / Anyone with the link.

### Key Decisions

1. **The list always applies.** Any direct viewer or editor grant, any viewer- or editor-team grant, opens the canvas at every rung (subject to the canvas being published and to the existing password gate for viewers).
2. **Three rungs in the UI: Restricted, Whole org, Public link.** Restricted is displayed for any of `private`, `specific_people`, `team`. Choosing Restricted writes **`private`**.
3. **The API keeps five values.** `specific_people` and `team` remain accepted on every write surface (management PATCH, authoring API, MCP `update_canvas`) and are stored as sent; the server treats the three as equivalent everywhere. No data migration. Documentation calls them legacy aliases of Restricted.
4. **Team grants are managed only in the list.** A rung change never deletes team grants. The legacy `teamIds` field on the settings routes keeps working as "replace the set of viewer-team grants" (same org and membership checks), and `access: "team"` without `teamIds` is accepted rather than refused with `TEAM_REQUIRED`.
5. **`SHARE_REQUIRES_PUBLISH` narrows to the two open rungs.** Moving an unpublished canvas to Whole org or Public link is still refused; moving between the restricted family is not (nothing opens).
6. **Whole org also admits listed guests.** A guest (outside-org email) on the list opens the canvas at `whole_org` too, because the list always applies. Public link admits everyone already.
7. **Shared discovery becomes rung-agnostic.** The "Shared" list shows every canvas the viewer holds a viewer grant on (direct or via a viewer team) regardless of rung; team-page discovery no longer requires the `team` rung.

### Actors

- **Owner** — sets General access, manages the list. Sees Restricted / Whole org / Public link.
- **Editor** — same Share tab powers as today (can change rung and list; cannot transfer/delete).
- **Listed viewer / viewer-team member** — opens the canvas at any rung once it is published (password gate applies).
- **Org member not listed** — opens only at Whole org / Public link (gallery unchanged).
- **Listed guest** — opens at every rung; guest-AI cap applies as today.
- **Admin** — filters and reads access in the admin table; sees "Restricted" grouping the three legacy values.
- **Agent (MCP / authoring API)** — reads and writes rungs by value; legacy values still round-trip.

### Requirements

**Server**
- R1. `decideCanvasAccess` admits a principal with a direct viewer/editor grant, or membership in a granted team, at `private`, `specific_people`, `team` and `whole_org`. `resolveAccessContext` computes `isAllowed` and `teamMatch` for every rung except `public_link`.
- R2. The realtime hub's revalidation and gated-drop paths reach the same verdicts as R1 (shared predicate, not a parallel switch).
- R3. `listDirectSharedWithUser` drops the `access = specific_people` filter; team discovery (`liveTeamCanvas`) drops the `access === "team"` requirement. Existing discoverability semantics for team pages are preserved unchanged otherwise.
- R4. `settings-update`: `SHARE_REQUIRES_PUBLISH` only when the target rung is `whole_org` or `public_link` and the canvas is unpublished.
- R5. Management and MCP settings routes: a rung change never calls `setCanvasTeams(clear)`; `teamIds` (when sent) replaces the viewer-team grant set with the existing `canGrantTeam` checks; `TEAM_REQUIRED` is only returned for an explicit empty `teamIds` array together with `access: "team"` (legacy shape), never for a bare rung change.
- R6. If any runtime capability check (guest AI cap, `me()` scope) is keyed on the `specific_people` rung rather than on the grant, key it on the grant. Verified at U4 start; today's guest-scope logic is expected to be grant-keyed already.
- R7. Admin canvas filters accept `restricted` as an alias for the family; per-rung admin stats group the family under `restricted` while still emitting the raw counts.

**Dashboard**
- R8. Share tab General access shows three options. Restricted is selected for any family rung; selecting it PATCHes `access: "private"`. The team picker that lived inside the Team rung is removed; the "AI for added people" section shows whenever the canvas is in the restricted family.
- R9. The intro sentence under "Share with people and teams" stands as written in #85 and is now true; the General access description reads "Who else can open the canvas, beyond the people and teams above."
- R10. Every rung label surface (`Badge` `ACCESS_BADGE`, `CanvasList` visibility, `DetailPanel` access fact, `AdminCanvasTable` filter and cell, Status tab) shows **Restricted** for the family, with secondary copy "People and teams you add" (plus "+ protected" when a password is set).

**Agent surface & docs**
- R11. Authoring API and MCP `update_canvas` keep accepting all five values; their descriptions and the generated docs (`/docs`, `/llms.txt`) explain Restricted and mark `specific_people` / `team` as legacy aliases.
- R12. Docs site pages that describe the ladder (`authoring/sharing.md`, `authoring/teams.md`, `sdk/authoring.md`, `agents/mcp.md`, `agents/llms.md`, `self-hosting/configuration.md`, `self-hosting/security-model.md`, `index.md`), the README, and the landing page LADDER/TOUR copy describe the three-rung model; `tour-sharing.webp` (and the README tour loop frame) is recaptured from the new picker.

### Key Flows

1. **Add a viewer, done.** Owner adds `liam@acme.test` as Viewer while General access is Restricted → Liam opens the published canvas immediately. No rung change needed.
2. **Open to the org, keep the guest.** Owner moves General access to Whole org → every org member opens it; a listed guest `pat@partner.com` still opens it; the guest-AI cap still applies to Pat.
3. **Back to Restricted.** Owner moves from Whole org to Restricted → unlisted org members lose access on their next request; listed people, teams and editors keep theirs; the hub drops unlisted viewers' live connections.
4. **Legacy API caller.** An MCP client sends `update_canvas { access: "specific_people" }` → accepted, stored, `get_canvas` returns `specific_people`, the dashboard shows Restricted.
5. **Legacy team caller.** `PATCH /settings { access: "team", teamIds: [design] }` → the viewer-team set becomes exactly `[design]`; editor-team grants untouched. A later `PATCH { access: "whole_org" }` leaves `[design]` in place.
6. **Shared list.** Liam (viewer at a `private` canvas) opens Shared → the canvas is listed with the owner's name.

### Acceptance Examples

- **Given** a published canvas at `private` with `liam` as a direct viewer, **when** Liam requests it, **then** 200 (password gate aside).
- **Given** a published canvas at `specific_people` whose only grant is the viewer team "Design", **when** a Design member requests it, **then** 200; a non-member org user gets 404.
- **Given** a canvas at `whole_org` with guest `pat@partner.com` listed, **when** Pat requests it, **then** 200 and Pat's AI calls count against the guest cap.
- **Given** an unpublished canvas, **when** the owner PATCHes `access: "specific_people"`, **then** 200; **when** they PATCH `access: "whole_org"`, **then** `SHARE_REQUIRES_PUBLISH`.
- **Given** a canvas at `team` with viewer team Design, **when** the owner PATCHes `access: "private"`, **then** the Design grant still exists and Design members still open the canvas.
- **Given** the Share tab for a canvas at `team`, **when** it renders, **then** the General access radio group has exactly three options and Restricted is checked; **when** the owner clicks Whole org then Restricted, **then** the last PATCH body is `{ access: "private" }`.
- **Given** the hub with a connected unlisted org viewer at `whole_org`, **when** the rung changes to `private`, **then** that connection is dropped and a listed viewer's connection survives.

### Success Criteria

- The #85 intro sentence is true for every row kind (viewer, editor, team, pending) at every rung.
- No dashboard surface shows "Specific people" or "Team" as an access value.
- Both dialects green; `/ce-code-review` run with real findings fixed; docs and landing text match the shipped picker.

### Scope Boundaries

- **In:** everything above.
- **Out:** rewriting stored legacy rung values (a later cleanup migration could map `specific_people`/`team` → `private`); changing the pending-invite / guest-viewer rules; changing the gallery (still `whole_org` + listed discoverability); per-org policy.

### Dependencies

- #84 (editor roles) and #85 (share-tab UX) merged — both on `main`.
- The docs/marketing PR from the roles round should land first so this round's doc edits build on its wording (they touch the same sharing pages).

### Open Questions

None blocking. Two verify-at-start items are recorded under Assumptions (guest-AI keying; the team discoverability flag).

### How This Work Fits Together

Editor roles (#84) made the list carry roles. #85 renamed the sections and wrote the intent sentence. This round makes the server honour that sentence and removes the two rungs that contradicted it. After it, the access model is: **a list that always applies + one "who else" dial**.

### Sources

- Decision: AskUserQuestion "How should the Share tab reconcile the people/teams list with General access?" → "Restricted model (Recommended)", 2026-09-02.
- `docs/plans/2026-09-01-1909-feat-canvas-editor-roles-plan.md`; `docs/solutions/2026-09-01-canvas-editor-roles-role-threading-and-transfer-atomicity.md`; `docs/solutions/2026-06-13-auth-invariant-checklist.md`.

---

## Planning Contract

### Key Technical Decisions (KTDs)

- **KTD-1 One predicate, two callers.** Add `isRestrictedRung(access)` to `packages/shared` and a single server helper `listedPrincipalMayOpen(ctx)` (direct grant OR team match) used by `decideCanvasAccess` and by the hub. The hub keeps no rung `switch` of its own.
- **KTD-2 Compute grants for every rung.** `resolveAccessContext` runs the allowlist and team-match lookups for all rungs except `public_link` (two indexed point queries; the cost was already paid on the two legacy rungs).
- **KTD-3 Store what was sent.** No normalisation of legacy rung values on write, no migration; equality lives in the predicate and the label maps. Rollback is a code revert.
- **KTD-4 Team-grant writes only through the list, plus the legacy `teamIds` replace.** `resolveTeamGrant` returns `write` only when `teamIds` was sent; it never returns `clear`. `setCanvasTeams(clear)` call sites are removed.
- **KTD-5 Restricted writes `private`.** The dashboard maps Restricted → `private`; the read side maps the family → Restricted. Tests pin both directions.
- **KTD-6 Admin alias, not a new enum member.** `restricted` is accepted by the admin filter parser and expanded to the three values in the query; the canvases `access` enum is untouched.

### High-Level Technical Design

```
                   ┌──────────────── list (grants) ────────────────┐
request ─▶ owner? ─▶ editorMatch? ─▶ capture ─▶ guest scope ─▶ listedPrincipalMayOpen? ─▶ rung:
                                                               (direct ∨ team)          private|specific_people|team → deny
                                                                                        whole_org → org member
                                                                                        public_link → publicEnabled (staticOnly)
```

- `apps/server/src/canvas/authorization.ts`: `resolveAccessContext` always loads `isAllowed` + `teamMatch` (except `public_link`); `decideCanvasAccess` checks `listedPrincipalMayOpen` before the rung switch; the switch keeps `private`/`specific_people`/`team` → deny, `whole_org` → org-scoped, `public_link` → as today.
- `apps/server/src/realtime/hub.ts` (~433/447): replace the rung-conditional checks with the helper; `dropGatedNonOwners` uses the same.
- `apps/server/src/db/repositories/canvases.ts:818` and the team-discovery path: drop rung filters.
- `apps/server/src/canvas/settings-update.ts`: publish guard on `whole_org | public_link` only.
- `apps/server/src/teams/sharing.ts` `resolveTeamGrant`: `write` iff `teamIds !== undefined` (non-empty, checked), `error TEAM_REQUIRED` iff `teamIds` is `[]` together with `targetAccess === "team"`, otherwise `none`. `management.ts` (~812-834) and `mcp/server.ts` settings handlers drop the `clear` branch.
- `apps/server/src/routes/admin.ts`: `ACCESS_RUNGS` filter accepts `restricted`; stats group.
- Dashboard: `routes/canvas.share.tsx` RUNGS → three entries with `matches(access)` and `writes` fields; `AccessLadder` removes the team picker; `components/Badge.tsx`, `CanvasList.tsx`, `DetailPanel`, `AdminCanvasTable.tsx`, `lib/api.ts` label helpers.
- Docs: pages listed under R12; `apps/server/src/http/landing-page.ts` LADDER; `scripts/screenshots.mjs` unchanged (the sharing shot already targets `#access`).

### Assumptions

- A1. Guest scope (the "capture → guest scope" step) is keyed on the grant, not the rung. **Verify at U1 start**; if rung-keyed, fix in U1.
- A2. Team-page discoverability is a flag on the team grant / canvas independent of rung. **Verify at U3 start**; preserve its semantics, only drop the rung condition.
- A3. `CanvasListItem` does not carry grant counts, so the Restricted secondary label is static ("People and teams you add"). If a count is available, prefer "Only you" when zero.

### System-Wide Impact

- **Access widening (intended):** existing canvases at `private` with stale viewer rows (added before this round and never "activated" by a rung flip) become openable by those viewers. This is the feature; it is called out in the PR body and the solutions entry.
- **Access narrowing:** none. Whole org / Public link unchanged for unlisted users.
- **Hub:** live connections re-evaluated on rung change with the same predicate; no new message types.
- **MCP parity:** no new tools; `update_canvas` / `list_shared_canvases` descriptions change; the inventory/role-matrix tests are unaffected.
- **Admin:** filter alias only.

### Risks

- **R-a Divergence between HTTP and hub verdicts.** Mitigated by KTD-1 and a parity test that runs both against the same fixtures.
- **R-b Legacy `teamIds` callers.** `replace` semantics are kept; the only behavioural change is that a rung change no longer clears. Covered by management + MCP route tests.
- **R-c Docs drift.** The docs-refresh workflow is not re-run for this round; the pages under R12 are edited by hand and `pnpm docs:build` + the docs route tests gate them.
- **R-d Screenshot drift.** `tour-sharing.webp` must be recaptured from the seeded demo (owner start script + `scripts/screenshots.mjs --landing --only sharing`) and `scripts/landing-gif.mjs` re-run.

### Docs notes

- Sharing page: replace the five-rung ladder table with the three-rung one and a "Legacy values" note for API readers.
- Teams page: "Share with a team" now means "add the team under Share with people and teams"; the Team rung paragraph goes.
- Security model: the invariant sentence becomes "the people-and-teams list always applies; General access only widens".
- Solutions entry: `docs/solutions/2026-09-02-restricted-access-model.md` (why the rungs folded, the access-widening note, the legacy alias policy).

---

## Implementation Units

One branch (`feat/restricted-access-model`), one PR, one local commit per unit, gates green (`pnpm lint && pnpm typecheck && pnpm test`) before moving on. Tests are written first for U1–U6.

### Phase A — server semantics

**U1 · Access decision honours the list at every rung**
- `packages/shared`: `isRestrictedRung`, `RESTRICTED_RUNGS`.
- `authorization.ts`: `resolveAccessContext` loads grants for all rungs but `public_link`; `listedPrincipalMayOpen`; `decideCanvasAccess` consults it before the rung switch; whole_org admits listed guests.
- Verify A1 (guest scope keying).
- Tests (`authorization.test.ts`): listed viewer at `private`; viewer team at `specific_people`; direct viewer at `team`; listed guest at `whole_org`; unlisted org member denied at all three family rungs; password gate still applies; unpublished still refused.

**U2 · Hub parity**
- `hub.ts`: `revalidateCanvas` + `dropGatedNonOwners` use the shared helper.
- Tests (`hub.test.ts`): rung change `whole_org → private` drops unlisted, keeps listed and team members; `private → private` with grant removal drops the removed viewer; parity test over shared fixtures against `decideCanvasAccess`.

**U3 · Discovery is rung-agnostic**
- `canvases.ts` `listDirectSharedWithUser`: drop the rung filter (keep viewer-role, published, not-archived, org-scoped conditions).
- Team discovery: drop `access === "team"`; verify A2 and keep discoverability.
- Tests: Shared list shows a `private` canvas with a viewer grant; team page shows a `private` canvas with a viewer-team grant; editor grants stay out of Shared.

**U4 · Settings and team-grant writes**
- `settings-update.ts`: publish guard narrows.
- `teams/sharing.ts` `resolveTeamGrant`: no `clear`; `write` only when `teamIds` sent; `TEAM_REQUIRED` only for explicit `[]` + `team`.
- `routes/management.ts` (~812-834) and `mcp/server.ts` `update_canvas`: remove `clear` call sites; keep `write`.
- Tests (`settings-update.test.ts`, `management.test.ts`, MCP settings tests, `integration/editor-scenarios.test.ts` new scenario): rung change keeps team grants; unpublished + `specific_people` OK; unpublished + `whole_org` refused; legacy `teamIds` replace works and respects `canGrantTeam`.

**U5 · Admin alias**
- `routes/admin.ts`: `restricted` filter alias; stats grouping.
- Tests: filter `access=restricted` returns canvases at all three values; per-rung stats include a `restricted` total.

### Phase B — dashboard

**U6 · Share tab: three rungs**
- `canvas.share.tsx`: `RUNGS` = Restricted (`matches` family, `writes: "private"`), Whole org, Public link; `AccessLadder` without the team picker; guest-AI section keyed on the family; General access description as R9; legend text.
- `PeopleAccessList.tsx`: intro sentence unchanged (now true); remove any "flip General access to Specific people" hints.
- Tests (`share.test.tsx`): three radios; Restricted checked for `team` and `specific_people` fixtures; PATCH body `{ access: "private" }`; team picker absent; guest-AI section visible under the family.

**U7 · Labels everywhere**
- `Badge.tsx` `ACCESS_BADGE` + `accessLabel`; `CanvasList.tsx` visibility; `DetailPanel` access fact; `AdminCanvasTable.tsx` filter options + cell; `lib/api.ts` comments/types (`AccessRung` unchanged; add `RESTRICTED_RUNGS` import from shared).
- Tests: badge label for each family value is "Restricted"; admin filter posts `restricted`; canvas list secondary copy.

### Phase C — agent surface, docs, marketing

**U8 · Authoring API + MCP descriptions + generated docs**
- `canvas-authoring.ts` and `mcp/server.ts` / `tool-kit` descriptions: three-rung wording with legacy aliases; `pnpm docs:build`; `docs/routes.test.ts` llms assertions updated ("Restricted", "legacy").

**U9 · Docs site, README, landing, screenshots, learnings**
- Pages under R12; `landing-page.ts` LADDER + any TOUR caption; `landing-page.test.ts` if assets change.
- Recapture `tour-sharing.webp` and the README tour loop (`scripts/landing-gif.mjs`) from the seeded demo (owner start script; `pnpm seed:canvases && pnpm seed:demo-apps && pnpm seed:collaborators`).
- `docs/solutions/2026-09-02-restricted-access-model.md` + solutions README index line; AGENTS.md status sentence.

### Phase D — review and ship

**U10 · Review, PR, merge**
- `/ce-code-review` on the branch; fix every real finding with regression tests (weight by the trust model: R1/R2 verdict parity is invariant-grade).
- Push, PR with the access-widening note, CI matrix green on both dialects, merge (`--squash --delete-branch --admin` per the ruleset), close the tracking issue, leave `main` green.

## Definition of Done

- All units merged in one squash commit; issue closed.
- R1–R12 satisfied; acceptance examples exist as tests and pass on both dialects.
- Docs site, README, llms.txt, MCP descriptions and landing copy describe the three-rung model; `tour-sharing.webp` shows it.
- Solutions entry written; no dashboard surface shows "Specific people" or "Team" as an access value.
