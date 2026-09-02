---
title: Share Permissions UX and Viewer Clone Parity - Plan
type: feat
date: 2026-09-02
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Share Permissions UX and Viewer Clone Parity - Plan

## Goal Capsule

- **Objective:** A canvas owner can understand and change who has access without reading duplicate or competing controls, and every listed viewer has the same safe clone capability regardless of whether the grant is direct or through a team.
- **Means:** Restructure the existing Share tab around one direct-access list, one General access control, Protection, Gallery, and an owner-only Advanced section; route direct and team viewer cloning through the same eligibility fences (KTD1, KTD2).
- **Authority:** `BUILD_BRIEF.md` and the restricted-access/editor-role plans own the access and role semantics. This plan changes presentation and the settled clone decision only.
- **Execution profile:** One branch and one PR, dual-dialect server tests, dashboard tests, generated docs validation, browser verification, code review, and green CI before merge.
- **Stop conditions:** Stop if implementation would change who may open a canvas, weaken clone lifecycle/protection fences, expose ownership transfer to editors, or require production access.
- **Tail ownership:** The implementing agent owns the issue, PR, CI, squash merge, issue closure, and solution note. Production deployment is excluded.

---

## Product Contract

### Summary

The Share tab will present the existing restricted-access model in the order people reason about it: who is explicitly listed, who else may enter, extra protection, and optional discovery. Duplicate link controls and explanatory filler will be removed. Direct viewer grants will gain the clone capability already held by team-granted viewers, with the same published, active, unexpired, and password-free fences.

### Problem Frame

The current Share tab repeats the live URL already shown in the canvas header, displays person and team add forms at once, gives every list row a visually heavy segmented role control plus a separate Remove button, and leaves ownership transfer inside the direct-access section. This makes a sound access model look more complicated than it is. Clone behavior also distinguishes two viewers who have the same read access solely by grant shape.

### Key Decisions

- **The page follows the access model's mental order.** Direct grants come first, General access decides who else enters, Protection adds password/expiry gates, Gallery controls discovery/templates, and Advanced holds ownership transfer. Governs R1-R6.
- **Direct and team viewer grants have clone parity.** (session-settled: user-approved - chosen over removing viewer-team cloning or preserving the asymmetry: both viewers can already read the eligible published files, so grant shape should not create a hidden capability difference.) Governs R7-R9.
- **The redesign preserves the existing visual system.** (session-settled: user-approved - chosen over reproducing the boxed mockup literally: the mockup's hierarchy is useful, while the repo's flat-band settings system remains the product language.) Governs R1-R6.

### Requirements

**Share page hierarchy and language**

- R1. The published Share tab starts with the heading **Sharing and permissions** and the description **Control who can open this canvas and what they can do.**
- R2. Remove the duplicate Share link section because the canvas detail header owns the same public URL, copy, and open actions at desktop and mobile widths.
- R3. The first section is **People and teams with direct access**; a People/Teams tab switches one compact add form, and both forms use **Add** rather than invite language.
- R4. Owners and editors retain the existing add, role-change, and remove powers. Existing rows show one compact Viewer/Editor selector and put Remove in the standard accessible row action menu; owner and legacy guest rows remain non-editable as today.
- R5. General access keeps exactly Restricted, Whole org, and Public link with the existing list-aware truthfulness and write behavior. Rename visible **Locks** terminology to **Protection** without changing password or expiry semantics.
- R6. Gallery & templates stays separate, and owner-only ownership transfer moves to an **Advanced** section at the bottom. Editors never see the transfer control.

**Clone parity**

- R7. A signed-in member with a direct viewer row may clone the same source a viewer-team member may clone.
- R8. Both viewer grant shapes require an accepted grant held by a signed-in member and an active, published, unexpired, password-free source. Pending invites, legacy guests, other non-member rows, archived, disabled, deleted, draft-only, expired, and password-protected sources remain opaque not-found.
- R9. The management route and `clone_canvas` MCP tool share the same eligibility helper and grant lookups. Existing owner/editor and gallery-template paths keep identical behavior and responses even though their checks move into the resolver. General access alone never grants clone eligibility.

**Documentation and verification**

- R10. User and agent documentation describes viewer-grant clone parity and the revised Share-page terminology; generated docs stay current.
- R11. Dashboard tests pin hierarchy, tabs, compact role changes, overflow removal, owner-only Advanced transfer, stale list handling, and unchanged access writes.
- R12. Clone regression tests run on both database dialects and prove direct/team parity plus every fence on HTTP and MCP surfaces.

### Acceptance Examples

- AE1. Given a published canvas with a direct viewer row, when that viewer clones it over HTTP or MCP, then the clone is created as their unpublished draft.
- AE2. Given the same direct viewer row on a draft-only, expired, protected, archived, disabled, or deleted source, when the viewer clones, then the source reads as not found.
- AE3. Given the Share tab with grantable teams, when the owner switches between People and Teams, then only the selected add form is present and the unified access list remains visible.
- AE4. Given a removable list row, when the owner opens its action menu and chooses Remove, then the existing confirmation and editor key-rotation follow-up behavior are preserved.
- AE5. Given an editor viewing the Share tab, when the page renders, then no Advanced ownership-transfer section or action is present.
- AE6. Given any General access value, when a signed-in member has no manager role, gallery-template path, direct viewer row, or viewer-team grant, then cloning reads as not found.
- AE7. Given the Share tab at desktop or mobile width, when the duplicate link band is absent, then the same public canvas URL remains visible and copyable in the canvas detail header.

### Scope Boundaries

- **In:** The published Share-tab hierarchy and copy, direct-access list controls, transfer placement, clone authorization parity, related tests/docs, and generated docs.
- **Out:** Changing the access decision table, adding new roles, changing gallery-template eligibility, changing password behavior, redesigning unpublished ShareLocked, schema changes, production deployment, and unrelated dashboard visual cleanup.

### Sources / Research

- `docs/plans/2026-09-01-1909-feat-canvas-editor-roles-plan.md`
- `docs/plans/2026-09-02-0830-feat-restricted-access-model-plan.md`
- `docs/solutions/2026-06-13-auth-invariant-checklist.md`
- `docs/solutions/2026-09-01-canvas-editor-roles-role-threading-and-transfer-atomicity.md`
- `docs/solutions/2026-09-02-restricted-access-model-the-list-always-applies.md`
- `docs/solutions/2026-09-02-mcp-list-parity-and-access-coverage.md`

---

## Planning Contract

### Key Technical Decisions

- KTD1. **One clone eligibility resolver.** Add one server-side resolver that owns manager, gallery-template, direct-viewer, and team-viewer eligibility through the existing role, repository, and team seams. HTTP and MCP call it and retain only transport-specific responses and audit handling. This wider consolidation is chosen over extending only the viewer branch because the agent-native contract requires both transports to wrap the same service-layer authorization decision.
- KTD2. **Restructure within existing settings primitives.** Keep `TabContentFrame`, `SettingsNav`, `Section`, `ActionMenu`, form controls, colors, type, and spacing tokens. The redesign changes content order and control density, not the dashboard design system.
- KTD3. **Lift transfer presentation, not list ownership.** `PeopleAccessList` continues to own generation-safe allowlist loading and mutations. It reports server-derived transfer candidates to the route, and a refresh token re-reads the list after transfer so ownership rows cannot stay stale.
- KTD4. **Semantic tabs and native selects.** The add-mode switch uses a keyboard-accessible tablist, while Viewer/Editor uses compact native selects. Removal uses the existing WAI-ARIA `ActionMenu`.
- KTD5. **Preserve anchor compatibility where practical.** Visible terminology changes from Locks to Protection, but the existing `locks` section id stays stable for saved links and screenshot tooling.

### System-Wide Impact

- **Authorization:** Clone capability widens only for a signed-in member already holding a direct viewer row. The clone is a durable copy owned by that actor and survives later source-grant revocation; source visibility does not widen.
- **Agent parity:** HTTP and MCP clone paths change together and continue to return opaque not-found outside eligibility.
- **Dashboard:** The route keeps existing settings mutations and async list guards. Only presentation and transfer placement change.
- **Operations:** No migration, config, or deployment work.

### Risks & Mitigations

- A broad `isPrincipalAllowed` lookup could accidentally include an editor or owner, but those callers already resolve management first; tests keep the manager path distinct and pin viewer fences.
- Moving transfer UI could leave the access list stale after a successful handoff; KTD3 requires an explicit refresh and regression test.
- Native selects and tabs can regress accessible naming; dashboard tests query by roles/names and browser verification checks keyboard focus and responsive layout.
- Copy derived from the allowlist can regress to a false empty state; the existing null/load-failure/navigation guards stay intact and remain tested.

---

## Implementation Units

### U1. Direct and team viewer clone parity

- **Goal:** Apply one clone eligibility contract to both viewer grant shapes.
- **Requirements:** R7-R9, R12; AE1-AE2.
- **Dependencies:** None.
- **Files:** `apps/server/src/canvas/clone-service.ts`, `apps/server/src/canvas/clone-eligibility.ts`, `apps/server/src/routes/management.ts`, `apps/server/src/routes/management.test.ts`, `apps/server/src/mcp/server.ts`, `apps/server/src/mcp/server.test.ts`.
- **Approach:** Move the complete eligibility decision into one resolver. It checks the canonical management role first, the org-scoped gallery-template query second, then the canonical direct allowlist and team match behind the shared active/published/unexpired/password-free fence. Both transports pass server-resolved actor context and use the same result.
- **Execution note:** Start by changing the dual-dialect MCP asymmetry test to the desired parity, then add HTTP direct-viewer coverage and shared fence cases.
- **Test scenarios:**
  1. A direct viewer and a viewer-team member each clone the same eligible Restricted source.
  2. A member whose access comes only from Whole org or Public link receives opaque not-found, as does any other no-role member.
  3. Direct and team viewers each receive opaque not-found for draft-only, expired, protected, archived, disabled, and deleted sources.
  4. A pending invite, a legacy guest, and any other non-member allowlist row never enter the viewer-clone path.
  5. An eligible direct-viewer clone starts with an empty people list, Restricted access, no expiry or gallery flags, and a fresh deploy key rather than copying the source's security state.
  6. Owners and editors still clone active managed canvases, including unpublished drafts, through the manager branch.
  7. Gallery-template cloning stays org-scoped and unchanged.
- **Verification:** Both dialects prove the HTTP and MCP contracts with unchanged audit and response shapes.

### U2. Share-page information architecture and controls

- **Goal:** Make the existing access model readable in one pass while preserving behavior.
- **Requirements:** R1-R6, R11; AE3-AE5.
- **Dependencies:** None.
- **Files:** `apps/dashboard/src/routes/canvas.share.tsx`, `apps/dashboard/src/components/PeopleAccessList.tsx`, `apps/dashboard/src/test/share.test.tsx`.
- **Approach:** Remove the redundant link band, add the page heading, switch add forms with semantic tabs, replace row segmented controls with compact selects, move removal into `ActionMenu`, and lift transfer presentation to an owner-only Advanced band. Preserve the generation counter, null mirror, confirmation dialogs, key-rotation prompt, and existing mutation hooks.
- **Execution note:** Preserve characterization coverage for mutation payloads and stale async responses while updating interaction tests to the new roles and labels.
- **Test scenarios:**
  1. The page heading and new section order render, with no duplicate Share link band.
  2. People and Teams tabs expose only their selected form and retain the unified list.
  3. Add person/team still send the selected viewer/editor role and refresh the list.
  4. Row role selects update roles, while legacy guests and the owner remain immutable.
  5. Remove lives in the standard action menu and preserves confirmation and editor key-rotation follow-up.
  6. Transfer appears only in Advanced for owners, accepts server-derived direct or team editor candidates, and refreshes rows after success.
  7. Pending invite, failed list load, and cross-canvas late-response copy stay truthful.
  8. General access still displays three options and Restricted writes `private`.
  9. The Protection section keeps the stable `locks` anchor id.
  10. The canvas detail header still exposes and copies the same public URL at desktop and mobile widths.
- **Verification:** Dashboard tests cover behavior and accessibility queries; desktop/mobile browser checks confirm hierarchy, focus, clipping, and responsive form layout.

### U3. Documentation, learnings, and ship gates

- **Goal:** Align documentation with clone parity and the revised UI, then complete the autonomous landing loop.
- **Requirements:** R10-R12.
- **Dependencies:** U1, U2.
- **Files:** `README.md`, `docs/site/authoring/sharing.md`, `docs/site/agents/mcp.md`, `docs/solutions/2026-09-02-mcp-list-parity-and-access-coverage.md`, `docs/solutions/<date>-share-permissions-ux-and-viewer-clone-parity.md`, generated documentation artifacts as required by `pnpm docs:build`, and `AGENTS.md` if the status sentence needs a behavior update.
- **Approach:** Replace team-only clone wording with viewer-grant wording, record the owner decision as resolved, document the hierarchy lesson, regenerate docs, run the prescribed code review, and land only after the CI matrix is green.
- **Test scenarios:**
  1. Generated docs contain the viewer-grant clone contract and no team-only eligibility claim.
  2. Documentation calls the UI sections People and teams with direct access, General access, Protection, Gallery & templates, and Advanced where relevant.
  3. Full lint, typecheck, dual-dialect server/dashboard tests, build, and docs-current checks pass.
- **Verification:** The PR records the visual and authorization changes, review findings are resolved, CI is green, the squash merge deletes the branch, and no deploy command runs.

---

## Verification Contract

| Gate | Evidence |
|---|---|
| Focused dashboard | Share tests cover hierarchy, tabs, role changes, removal, transfer, and stale async states. |
| Focused server | Management and MCP clone tests pass on SQLite and Postgres/PGlite. |
| Generated docs | `pnpm docs:build` leaves generated content current. |
| Full local | `pnpm lint`, `pnpm typecheck`, and `pnpm test` are green. |
| Visual | The live local Share tab is checked at desktop and mobile widths, including keyboard interaction and the header's visible/copyable public URL. A reader can state who currently has access and what each listed role can do after one pass through the page. |
| Review | `/ce-code-review` runs against the branch; real P0/P1 and high-value P2 findings receive fixes and regression tests. |
| Landing | The GitHub CI matrix is green before squash/admin merge; issue closure and branch cleanup follow. |

---

## Definition of Done

- Direct and team viewers have identical clone outcomes for eligible and fenced sources over HTTP and MCP.
- The Share page matches R1-R6 without changing access, role, password, expiry, gallery, or transfer semantics.
- Dashboard interaction and async truthfulness tests pass.
- Documentation and generated docs describe the shipped UI and clone rule.
- Browser verification covers desktop, mobile, and keyboard use.
- Full local gates, code review, and the GitHub CI matrix are green.
- The PR is squash-merged with its branch deleted, the tracking issue is closed, and the solution note captures the reusable lessons.
- No abandoned implementation code remains and production is untouched.
