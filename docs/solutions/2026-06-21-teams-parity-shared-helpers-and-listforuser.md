---
title: "Tenancy P2 teams: HTTP↔MCP parity drifts unless the read/grant logic is shared, plus a listForUser wrapped-row gotcha"
date: 2026-06-21
tags: [auth, tenancy, teams, mcp, dual-dialect, gotcha]
area: [auth, mcp, data]
---

# Tenancy Phase 2 — teams: three things that bit, and how to avoid them

## 1. "Wrap the same service" must be literal — a hand-copied projection silently drifts

The agent-native parity rule says the MCP tools "wrap the SAME service layer the HTTP
routes use." P2 first shipped the team-grant flow, the `list_teams` list, and the
`shared-with-teams` read as **hand-copied** logic in both `routes/management.ts`/`routes/teams.ts`
**and** `mcp/server.ts`. They looked identical — but the MCP copy of the shared-with-teams
projection had quietly dropped `hasPreview` and `owner.avatarUrl` that the HTTP route
returned (and that the dashboard's `TeamSharedCanvas` type declares). Code review (the
api-contract persona) caught it as a P1 field-divergence.

**Fix / rule:** extract the data + authz into one place — here `apps/server/src/teams/sharing.ts`
(`resolveTeamGrant`, `listSharedWithTeams`, `resolveVisibleTeams`). Each surface adds only
its **presentation** (the HTTP route resolves preview ids + URL; the MCP tool does the same;
both call the one helper). "Parity" is a property of *shared code*, not of *two copies that
happened to match at write time*. If you find yourself pasting a read/grant block into the
MCP server, that's the signal to extract.

## 2. `update_canvas`/PATCH settings: gate the team-grant write on the EFFECTIVE rung, not just `targetAccess === 'team'`

The grant flow originally ran only when `targetAccess === 'team'` (the rung was being set).
But the MCP exposes `teamIds` as an independent optional param, so an agent calling
`update_canvas({id, teamIds:[…]})` on a canvas **already** at `access:'team'` got
`targetAccess === undefined` → the grant write was silently skipped (the dashboard hid the
bug by always sending `{access:'team', teamIds}`). The shared `resolveTeamGrant` now also
fires when `teamIds` is sent and the canvas is already team-scoped, and still rejects an
empty set (`TEAM_REQUIRED`) so a grant change can't leave a deny-to-everyone canvas. It also
emits the `share_change` audit on a grant-only change (otherwise re-picking teams left no
trail).

## 3. A join that projects under an alias returns wrapped rows — `as unknown as T[]` lies

`teamsRepository.listForUser` did `db.select({ team: teamsT })…` and cast the result
`as unknown as Team[]`. Drizzle returns `{ team: Team }[]`, so every caller's `t.id` was
`undefined` — which made the `/api/teams` `mine` flag (and the dashboard share picker's
`filter(t => t.mine)`) **always false**. The cast hid it from the compiler. Caught by the
new MCP `list_teams` test asserting `mine: true` for a team the caller created.

**Rule:** when a Drizzle select projects under a key (`select({ team: t })`, or any join that
nests by table alias), unwrap explicitly (`rows.map(r => r.team)`) and type the rows as
`Array<{ team: Team }>` — never `as unknown as Team[]`. This is the same nested-projection
trap noted in [the dual-dialect seam learning](2026-06-13-dual-dialect-drizzle-seam.md).

## 4. Cross-org team actions must be opaque (not-found), not forbidden

`teamsService.manageable`/`addMember`/`removeMember` returned `FORBIDDEN` (403) for a team in
another org the actor can't manage, vs `TEAM_NOT_FOUND` (404) for a non-existent id — a
403-vs-404 existence leak across the org boundary (§12.0 opacity). A `visible(actor, team)`
check (`actor.isAdmin || actor.orgIds.has(team.orgId)`) now maps a cross-org team to
not-found before the manage check, matching the roster route's opaque 404. (No live exploit
in single-org P2, but the predicate must be correct for P3 multi-org.)
