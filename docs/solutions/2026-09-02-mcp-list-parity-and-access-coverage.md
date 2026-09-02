---
title: MCP list parity and access coverage — prove shared seams, then test divergence points
type: architecture
area: auth
date: 2026-09-02
---

# MCP list parity and access coverage — prove shared seams, then test divergence points

**Plan:** `docs/plans/2026-09-02-1215-feat-mcp-list-canvases-parity-plan.md` · **Issue:** #90 · **Follows:** editor roles (#82/#84) and the restricted access model (#86/#89)

## What the round established

`list_canvases` now mirrors the dashboard list without owning a second query implementation. Both surfaces normalize the same filters and call `listForActorFiltered` plus `actorSummary`. MCP adds `scope`, the four state chips, `offset`, normalized pagination metadata, and `summary`; its old arguments and canvas-row shape are unchanged.

The broader review confirmed the central permission model and found one real projection defect: the authoring list advertised `archived` and `disabled` publication states but discarded those rows before calling `publicationStatusOf`. It now returns every non-deleted authored canvas the caller still manages, including draft, published, expired, unpublished, archived, and disabled rows. Deleted rows remain deliberately omitted.

## Coverage grid

The grid is deliberately factored around shared decisions rather than generating thousands of copies of the same assertion. `decideCanvasAccess` owns the audience verdict; `resolveManagementGrant` owns management roles; `classifyMutability` owns owner/editor/owner-only behavior. Every independently implemented seam then has parity or integration witnesses on both database dialects where SQL is involved.

### Principal × persisted General-access value (55 cells)

`Full` includes runtime primitives and realtime when the capability is enabled. `Static` is HTML/assets only. Password and lifecycle gates are layered afterward.

| Principal | `private` | `specific_people` | `team` | `whole_org` | `public_link` |
|---|---:|---:|---:|---:|---:|
| Owner | Full | Full | Full | Full | Full |
| Direct editor | Full | Full | Full | Full | Full |
| Editor-role team member | Full | Full | Full | Full | Full |
| Direct viewer | Full | Full | Full | Full | Full |
| Viewer-role team member | Full | Full | Full | Full | Full |
| Pending invite, no user yet | Deny | Deny | Deny | Deny | Static as anonymous only |
| Retained legacy guest on this canvas's list | Full | Full | Full | Full | Full |
| Unlisted member of the canvas org | Deny | Deny | Deny | Full | Static |
| Member of another org, tenancy active | Deny | Deny | Deny | Deny | Static |
| Admin without a role | Deny | Deny | Deny | Full only when in the canvas org | Static |
| Anonymous | Deny | Deny | Deny | Deny | Static |

Evidence:

- `apps/server/src/canvas/authorization.test.ts` exhausts the centralized decision table, including editor bypass, list lookup at every rung, legacy guest scope, admin non-bypass, tenancy, and static-only public access.
- `apps/server/src/db/repositories/canvases.test.ts`, `apps/server/src/integration/tenancy-scenarios.test.ts`, `apps/server/src/integration/team-scenarios.test.ts`, `apps/server/src/integration/invite-scenarios.test.ts`, and `apps/server/src/integration/editor-scenarios.test.ts` prove the repository lookups and real composed-app joins on SQLite and Postgres/PGlite.
- A pending invite is data for a future verified principal, not a principal itself. First verified sign-in materializes the row; before that, only an independently open General-access value can admit the visitor.

### Lifecycle and gate overlay

| State/gate | Serve + runtime | Realtime re-auth | Management / MCP | Authoring projection | Clone |
|---|---|---|---|---|---|
| Never published | No bytes/runtime | Drop | Owner/editor may manage and publish | `draft` | Owner/editor may seed from their draft; viewer-team path is denied |
| Published | Audience table above | Same full-access verdict as HTTP | MCP role matrix below | `published` | Role/template/team-viewer rules apply |
| Share expired | Owner/editor bypass; other principals denied | Same verdict as HTTP | Still manageable | `expired` | Team-viewer path denied |
| Password set | Owner/editor and retained guest bypass; other admitted principals face the gate | A successfully gated connection survives; setting/changing the password drops old gated sockets | Still manageable | Lifecycle unchanged; `hasPassword` is separate | Team-viewer path denied |
| Archived | No serve | Drop | Listed under archived scope; owner/editor may unarchive | `archived` | Opaque not-found |
| Disabled by admin | Owner gets disabled response; non-role callers do not gain management/content knowledge | Drop | Known owner/editor gets the disabled mutation contract; admin restoration stays on admin routes | `disabled` | Opaque not-found |
| Soft-deleted | Opaque not-found | Drop | Omitted except dedicated admin restore surfaces | Omitted | Opaque not-found |
| Authoring share revoked (`revokedAt`) | No serve | Drop | Still manageable; settings-only authoring update is refused, bundle update republishes | `unpublished` | Viewer paths denied |

Every publish path that can revive a revoked authoring share is now pinned: dashboard draft publish, keyed Deploy API deploy, MCP `deploy_canvas`, and authoring bundle `PUT` all clear `revokedAt`. The reason is subtle: `publicationStatusOf` intentionally reads `revokedAt` before `hasCurrentVersion`, so publishing only the version pointer would otherwise produce live bytes reported as unpublished.

### Surface witnesses

| Surface | Evidence and result |
|---|---|
| Canvas HTML/static | The shared authorization table plus dual-dialect tenancy/team/invite integration scenarios cover every principal class. Offline states never serve content. |
| Runtime KV/files/AI/identity | `capability-scenarios.test.ts` exercises the composed gateway → access → capability pipeline on both dialects; anonymous Public-link access remains `STATIC_ONLY`. |
| Realtime hub | The rung matrix covers direct, team, and unlisted members. New parity rows cover password-gated, expired, cross-org tenancy, retained guest, and anonymous principals against the HTTP decision. |
| Management routes | Owner/editor grants, demotion/removal, transfer, disabled/archived ordering, people list, and owned-or-edited inventory are covered through route and dual-dialect integration suites. |
| MCP | The inventory test rejects any canvas tool missing from `tool-roles.ts`. The 33 canvas-scoped tools run as owner/editor/viewer/no-role on each dialect: 264 role-gate executions, with `OWNER_ONLY` distinct from opaque not-found. Tool descriptions were checked against their schemas/handlers; `update_canvas.teamIds` correctly describes replace semantics, the exact empty-array carve-out, and persistent grants. |
| Authoring API | Both dialects now project every reachable publication state and preserve frozen legacy `status`; owner/editor/no-role behavior and owner entitlement are separately pinned. |
| Deploy API `GET` and publish | `GET` returns the established `publicationState` plus additive `accessMode`; bearer-key isolation stays canvas-scoped. Republish clears `revokedAt`. |
| Dashboard lists | The shared owned-or-edited repository covers owner/direct-editor/team-editor membership; Shared covers direct/team viewers but excludes editors; gallery stays listed, published, unprotected, unexpired, and org-scoped. All SQL predicates run on both dialects. |
| Share tab | Pending rows do not inflate “can open now” copy; legacy guests are named as password-exempt; a failed list read is explicit; navigating to another canvas clears the old mirror before the next response. |
| Clone | Owner/editor and gallery-template paths remain as shipped. Viewer-team cloning is fenced by published + active + unexpired + unprotected. Archived and disabled now have explicit HTTP and dual-dialect MCP regression coverage. |

## Compatibility decision: `shared: false` with `teamIds: []`

The deprecated boolean form is intentionally accepted under the same narrow carve-out as `access: "private"`: only a real transition from stored `team` to another value turns `teamIds: []` into a no-op. The viewer-team grants stay on the people-and-teams list. A bare empty array, an echoed non-team value, or a transition between two other values remains `TEAM_REQUIRED`. The test composes the real settings resolver with the management route and runs on both dialects.

## Open product decision: who may clone?

The shipped behavior is asymmetric:

- a viewer admitted through a viewer-role **team** may clone a published, active, unexpired, unprotected canvas;
- a viewer admitted through a **direct person row** may open the same canvas but cannot clone it.

This round pins the asymmetry instead of silently changing authorization. The owner has three coherent options:

1. Allow every listed viewer to clone eligible published content. This best matches “the list always applies” and is the least surprising because viewers can already read the published files.
2. Remove viewer-team cloning and reserve cloning for owners, editors, and explicitly templatable gallery entries. This is the narrowest capability model.
3. Keep the asymmetry and document team membership as an intentional clone capability. This preserves compatibility but needs a product reason users can understand.

Recommendation: option 1 unless team-based cloning is meant to represent a distinct organizational trust grant.

## The manual walkthrough gate

Dev auth cannot hold two browser identities at once. The remaining editor-role walkthrough was therefore closed with a real composed-app integration scenario on both dialects:

- F1: add two colleagues as editors and observe immediate management access;
- F7: both open one file at the same hash, the first save lands, the stale second save returns `DRAFT_CONFLICT`, and a refreshed save succeeds;
- F4: transfer ownership to an editor and verify the old owner becomes an editor;
- F6: the new owner demotes then removes the former owner, with view access retained after demotion and revoked after removal.

This is automated integration evidence, not a claimed human two-browser walkthrough.

## Reusable lesson

When an authorization model is centralized, a coverage grid should distinguish **decision cells** from **seam cells**. Exhaust the principal/access table once at the pure predicate, prove each database lookup on every dialect, then test each caller that could discard context, reorder gates, or reshape the result. That produces stronger evidence than repeating the same happy path at every endpoint—and it is exactly how the authoring projection defect surfaced: the decision was correct, but one caller filtered valid lifecycle rows before projection.
