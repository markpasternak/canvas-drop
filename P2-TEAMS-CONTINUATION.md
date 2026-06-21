# Tenancy P2 (teams) — continuation handoff

**You are resuming an in-flight autonomous round.** Branch `feat/tenancy-p2-teams` (worktree
`/Users/markpasternak/Code/Work/canvas-drop-multi-tenant-orgs`). The user (Mark) wants the **full
round executed end-to-end and a PR opened — do NOT merge** (Mark merges; the repo's ruleset bypass
is his). Read `docs/plans/2026-06-20-003-feat-tenancy-p2-teams-plan.md` (the deepened, implementation-
ready plan) first — it has the KTDs, the per-unit detail, and the locked decisions.

> **Delete this file in U8 before opening the PR.**

## Locked decisions (do not re-litigate)
- **Flat roles** — `role` columns exist but only `'member'` is written; management = creator-or-
  operator. RBAC is P4.
- **Strictly team-scoped** — `access` is single-valued (`team` XOR `whole_org`). A team canvas is
  reachable/listable/cloneable only by a member of a granted team; it does **not** appear in the
  org-wide gallery, only a separate "shared with my teams" view.

## Done (committed, full dual-dialect suite GREEN — 2,149 tests)
- **U1** `90b47f1` — schema: `org_members`, `teams`, `team_members`, `canvas_teams` (both dialects,
  migrations `0027_tenancy_teams`, parity-test maps, types in `packages/shared/src/db/types.ts`).
- **U2** `b11e992` — `orgMembersRepository`; resolver `makeOrgMembershipResolver(orgs, orgMembers)`
  now takes `{id,email}`, **materializes** a `source='domain'` row but **returns the LIVE derived
  set** (the real-time boundary; a stale row never widens access). `tenancy/reconcile.ts` + CLI
  `pnpm tenancy:reconcile` (revoke stale org_members + cascade team_members). Wired at
  `auth/gateway.ts` + `mcp/routes.ts` + `app.ts`.
- **U3** `1350ce8` — `db/repositories/teams.ts` (team CRUD + members + `canvas_teams` grants + the
  auth-critical `teamMatch(canvasId,userId,viewerOrgIds)` re-join + `listCanvasIdsForUserTeams`).
  `teams/service.ts` (the ONE authz layer routes+MCP share). `routes/teams.ts` mounted at
  `/api/teams`. Rejection-first service tests.
- **U4** `c18181b` — the `team` rung across **all three seams**: `decideCanvasAccess` case `team`
  (members-only; needs tenancyActive + home org + `teamMatch` + unexpired); `teamMatch` resolved in
  `resolveAccessContext` (serve), `canvas-api.ts` (runtime API), and `realtime/hub.ts` (live re-auth,
  fail-closed). `settings-update.ts` `TEAM_REQUIRED` guard; `management.ts` PATCH grant flow
  (`teamIds`; owner may grant only own teams in the canvas's org, KTD4; clears on rung change).
  `'team'` added to shared `AccessRung`. **The `teams` dep is OPTIONAL + fail-closed** on
  CanvasAccessDeps/CanvasApiDeps/ManagementDeps so non-team suites needn't wire it.
- `bedbe7d` — backup fix: the 4 new tables added to `BACKUP_TABLE_ORDER` (FK-safe order).

## Remaining — U5, U6, U7, U8

### U5 — "My teams" view + dashboard (React, `apps/dashboard/`)
- A **team picker in the share control** (`routes/canvas.share.tsx`): add a **Team** rung to the
  AccessLadder; when chosen, show a multi-select of the owner's teams (from `GET /api/teams`,
  filter `mine===true`) and POST `access:'team'` + `teamIds` via `lib/api.ts` `updateSettings`.
  Gate the rung disabled on a Personal canvas (no org) like whole_org's `orgRungDisabled`.
- A **"shared with my teams"** list. The server read isn't built yet — add one: e.g.
  `GET /api/canvases?scope=teams` (or a `/api/teams/shared` route) using
  `teams.listCanvasIdsForUserTeams(userId, orgIds)` → fetch those canvases. Wire a dashboard view.
- **Team management UI**: create/join/leave a team + roster, from `/api/teams` + `/:id/members`.
- `ScopeBadge` (`components/Badge.tsx`) — add a team variant. `lib/api.ts` `Canvas` type may need
  `teamIds`/`access:'team'`; `createCanvas`/`updateSettings` types.
- Tests: dashboard `src/test/*.test.tsx` (the share test `share.test.tsx` is the pattern — note the
  P1 gallery-listing/guest-AI tests there are sensitive to copy).

### U6 — MCP parity (`apps/server/src/mcp/`)
- Wrap the SAME `teamsService` + `teams` repo (agent-native parity; non-owned id = not-found; same
  audit). Add tools: `create_team`, `list_teams`, `rename_team`, `delete_team`, `add_team_member`,
  `remove_team_member`, `list_team_members`, and the **team grant** (extend `update_canvas` with
  `access:'team'`+`teamIds`, OR a `set_canvas_teams` tool — match the `update_canvas` settings path).
  `McpToolDeps` already has `orgMembers`; add `teams` + `teamsService`. The `McpCaller` carries
  `orgIds` + `tenancyActive` — build the `TeamActor` from those. Consider adding `teams` to `whoami`.
- Tests: `mcp/server.test.ts` pattern.

### U7 — Docs parity (R9) — **the served docs are a BUILT artifact**
- Edit: `docs/site/authoring/sharing.md` (add **Team** to the access ladder between Specific people
  and Whole org), `self-hosting/security-model.md` (invariant #3 — the `team` predicate + KTD3
  re-join), `authoring/create-and-publish.md`, `agents/mcp.md` + `agents/llms.md` (team tools),
  `README.md`.
- **Run `pnpm docs:build`** (regenerates `apps/server/src/docs/generated-content.ts` — CI asserts no
  drift) and the integrity test (`apps/server/src/docs/integrity.test.ts` checks real-config-var +
  no-dead-`/docs`-links). Org-agnostic: no hardcoded instance domains.

### U8 — Invariant tests + review + PR
- HTTP-level invariant tests via the scenario harness (`integration/scenario-harness.ts` +
  `tenancy-scenarios.test.ts` pattern): a `team` canvas serves 200 to a team member, 404 to a
  non-member/guest, across serve + runtime-API; revoked-org-member dropped; reconcile end-to-end.
- Run `/ce-code-review` (security + adversarial). **Fix everything real** (weight to the trust model:
  `docs/solutions/2026-06-13-auth-invariant-checklist.md`) with regression tests.
- Delete this handoff file. Push. Open the PR (title `feat: Tenancy Phase 2 — teams (#…)`), full
  body. **Do NOT merge.**

## Conventions / gotchas (load-bearing)
- One commit per unit; gate each with `pnpm lint && pnpm typecheck && pnpm test` (dual-dialect).
  `pnpm format` before committing (biome sorts imports + formats the drizzle meta json).
- **`pnpm docs:build` drift gate** — editing `docs/site/*.md` without rebuilding fails CI.
- Dual-dialect is sacred — schema changes need both `schema.pg.ts`+`schema.sqlite.ts` + generated
  migrations for both; the parity test maps in `schema.test.ts` must list new tables.
- `BACKUP_TABLE_ORDER` (`ops/backup.ts`) must list every table (a guard test enforces it).
- Auth is invariant-critical — read `docs/solutions/2026-06-13-auth-invariant-checklist.md`; the
  real-time boundary is the LIVE resolver / `teamMatch` re-join, never a materialized table.
- `main` is push-protected (PR only). Pre-push gate = the full suite green locally + CI green.
