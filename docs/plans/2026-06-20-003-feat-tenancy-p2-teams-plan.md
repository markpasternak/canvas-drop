---
title: "feat: Tenancy Phase 2 — teams (intra-org sharing groups)"
type: feat
date: 2026-06-20
origin: docs/brainstorms/2026-06-20-multi-tenant-org-isolation-requirements.md
status: ready
reviewed: 2026-06-21
depth: deep
phase: 2
depends_on: docs/plans/2026-06-20-002-feat-tenancy-p1-org-boundary-plan.md
invariant_critical: true
---

# feat: Tenancy Phase 2 — Teams (8 units)

> **Depends on Phase 1** (org boundary, the DI membership resolver, the three-seam re-scope) —
> now **merged + live on prod** (org Seenthis). Invariant-critical: the `team` rung is a new
> authorization predicate (across the same three seams) → `/ce-code-review` (security + adversarial)
> gates the PR.

## Summary

Add **teams**: members-only groups inside an org, **self-serve** (any member creates a team and
invites other members — D6). A canvas owner can scope a canvas to one or more of their teams via the
`team` rung (reserved in P1's CHECK, implemented here), slotted between `specific_people` and
`whole_org`. Phase 2 also introduces **explicit membership rows** (`org_members`) so P1's *derived*
membership becomes *derived ∪ explicit* behind the same resolver — and adds the **reconciliation**
that revokes stale membership (org **and** team) when a domain is removed (R13, partial).

## Decisions locked (2026-06-21, Mark)

- **Roles: FLAT.** `org_members.role` / `team_members.role` exist but P2 writes only `'member'`.
  Management = **creator-or-instance-operator** (KTD5). Real `{owner, admin, member}` RBAC is **P4**.
- **Team canvases are STRICTLY team-scoped.** `access` stays single-valued (`team` **XOR** `whole_org`,
  never both). A `team` canvas is reachable/enumerable/cloneable **only** by a member of one of its
  granted teams — it does **not** surface in the org-wide gallery. (Resolves both open questions.)

## P1 interface verification (2026-06-21 — re-checked against the shipped, merged code)

Confirmed the plan's load-bearing assumptions hold, and pinned three concrete deltas to apply:

| What | Status | Delta for P2 |
|---|---|---|
| `OrgMembershipResolver = (user:{email}) => Promise<Set<string>>` (`auth/org-membership.ts`) | ✅ Designed as the P2 seam ("swap the body for derived ∪ explicit") | **Signature → `(user:{id,email})`** so U2 can materialize `org_members(user_id)`. Only call site is `auth/gateway.ts:74` (`deps.orgMembership(user)`) — `user` already has `id`. One-line change. |
| `decideCanvasAccess` `case "team"` (`canvas/authorization.ts:152`) | ✅ Reserved deny guard (404 owner_only) | U4 replaces with the real check via a new `AccessContext.teamMatch?: boolean`, resolved in `resolveAccessContext` (mirrors `isAllowed` for `specific_people`); honor `expired` + `gate`; deny when `!tenancyActive` or `orgId === null`. |
| `AccessContext` (`isAllowed`/`publicEnabled`/`tenancyActive`) | ✅ Pure-table + caller-resolved I/O (KTD4) | Add `teamMatch`; `resolveAccessContext` runs the canvas_teams ⋈ team_members ⋈ org_members lookup only when `access === 'team'`. |
| Gallery/clone scope `GalleryScope{tenancyActive, viewerOrgIds}` (`db/repositories/canvases.ts:140`) | ✅ whole_org org-scoped; public_link universal | U4: the **clone**-eligibility predicate gains a `team` branch (team member may clone). The **org-wide gallery list stays `whole_org`/`public_link`** (strictly team-scoped → team canvases live only in the "my teams" view, U5). |
| `settings-update` access union + `ORG_REQUIRED` guard (`canvas/settings-update.ts:99`) | ✅ whole_org requires a home org | U4: add `'team'` to the input union; gate `access='team'` on `tenancyActive` + `orgId` + ≥1 `canvas_teams` grant; mirror the 409 pattern (`TEAM_REQUIRED`). |
| `canvases_access_chk` reserves `team` (`schema.sqlite.ts:280`) | ✅ Reserved (KTD6) | **No CHECK migration.** P2 schema is purely additive (four tables). |
| member `Principal {id,isAdmin,orgIds:Set}` (`http/types.ts:17`) | ✅ Carries `orgIds` | **No Principal change** — team membership is resolved per-canvas in `resolveAccessContext`, not carried on the principal. |
| `orgsRepository` (`ensureOrg/findByDomain/listDomains/findById/list`) | ✅ | Add a sibling `teamsRepository` + `orgMembersRepository`; reconcile mirrors `tenancy/cutover.ts`'s dual-dialect boundary + dry-run shape. |

## Problem Frame

Phase 1 gives "my whole org"; teams give "the subset I actually collaborate with." Teams are the
grouping the user explicitly asked for ("within an organization you can have multiple teams who
share stuff").

## Requirements Traceability

| Requirement | Units |
|---|---|
| R9 Teams (model, self-serve, `team` rung, "my teams" view, MCP **+ docs**) | U1–U7 |
| R13 Lifecycle reconciliation (org + team) | U2 |
| R-sec Invariant tests | U2, U4, U8 |

## Key Technical Decisions

- **KTD1 — Explicit membership, materialized at login; no invite source yet.** `org_members(org_id,
  user_id, role, source)` with `source = 'domain'` only in P2 (an `'invite'`/cross-domain flow is
  **not** planned here — D8 defers it; don't ship a `source` value nothing creates). The P1 resolver
  is **extended** to *materialize* a `source='domain'` row on login (idempotent upsert) and return
  `derived ∪ explicit`; in P2 explicit ≡ the domain rows, so the union is behaviorally identical to
  P1 but the seam is in place. Requires U1's schema + the `id` signature delta above.
- **KTD2 — Reconciliation cascades org → team.** When the operator removes a domain, revoke
  `source='domain'` `org_members` rows for it **and** cascade-revoke those users' `team_members` rows
  — else a now-outsider keeps team-canvas access (a real leak). One tested reconcile step with a
  dry-run delta, shaped like `cutover.ts` (single dual-dialect boundary).
- **KTD3 — Teams belong to exactly one org; members-only.** `teams(org_id, name, slug, created_by)`,
  `team_members(team_id, user_id, role)`. A `team_members.user_id` must have a live `org_members` row
  for the team's org — enforced at **write** AND re-checked at **read** (the `team` rung re-joins
  `org_members`, so a revoked member can't ride a stale `team_members` row).
- **KTD4 — `team` rung via a grant table.** `canvas_teams(canvas_id, team_id)`: `access='team'` means
  "a member of any granted team." Owner may grant only teams they belong to **at grant time**; the
  grant is then **independent** of the owner's continued team membership. `access` stays single-valued.
- **KTD5 — `role` is a placeholder (flat in P2).** Writes only `'member'`; management = creator or
  instance operator. `{owner,admin,member}` RBAC lands in P4.
- **KTD6 — `team` CHECK already reserved (P1).** No CHECK migration; P2 schema = the four new tables.
  Generate dual-dialect migrations; parity test green.

## Implementation Units

### U1. Schema — `org_members`, `teams`, `team_members`, `canvas_teams`
Define all four in **both** `schema.sqlite.ts` + `schema.pg.ts`, mirroring the `orgs`/`orgDomains`
shared-column-helper style. Constraints/indexes:
- `org_members`: unique `(org_id, user_id)`; index `user_id`; FKs → `orgs`, `users`; `role` default
  `'member'`, `source` (`'domain'`).
- `teams`: unique `(org_id, slug)`; index `org_id`; FKs → `orgs`, `users(created_by)`.
- `team_members`: unique `(team_id, user_id)`; index `user_id`; FKs → `teams`, `users`.
- `canvas_teams`: PK/unique `(canvas_id, team_id)`; index `team_id`; FKs → `canvases`, `teams`.
FK creation order documented. Generate dual-dialect migrations (`--name=tenancy_teams` for pg + sqlite),
commit `drizzle/{pg,sqlite}/*`. **Tests:** schema-parity test green; the four tables exist on both
dialects. No `canvases` CHECK change.

### U2. Explicit membership (materialize-at-login) + reconciliation
- `orgMembersRepository`: `upsertDomainMember(orgId,userId)` (idempotent), `listOrgIdsForUser(userId)`,
  `revokeDomainMembersForDomain(...)`, `listTeamMembersForUser(...)`.
- Change `OrgMembershipResolver` → `(user:{id,email})`; body: derive org (findByDomain) → upsert the
  `source='domain'` row → return `listOrgIdsForUser` (= derived ∪ explicit). Update `gateway.ts:74`.
- `reconcileTenancy` (mirrors `cutover.ts`): on a removed domain, revoke its `source='domain'`
  `org_members` rows **and** cascade `team_members`; dry-run delta + `--apply`.
- **Tests:** union correctness (derived-only today); domain-removal revokes org **and** team access on
  the **next request** (rejection-first); resolver is server-only (never client input).

### U3. Team service + self-serve CRUD
`teamsRepository` + a team service: `create` (any member of an org), `rename`/`delete` (creator or
instance operator — KTD5), `addMember`/`removeMember` (target must be a same-org member — KTD3 write
check). Management routes + audit events (`team_create`, `team_rename`, `team_delete`,
`team_member_add`, `team_member_remove`), wrapping the service like P1's management routes.
**Tests:** a guest cannot create/join; a member of org A cannot be added to an org-B team; non-creator
non-operator cannot rename/delete; rejection-first.

### U4. `team` rung in the three seams + canvas→team grants
- `AccessContext.teamMatch?: boolean`; `resolveAccessContext` resolves it for `access==='team'`
  (principal is a member of a `canvas_teams[canvas]` team **and** holds a live `org_members` row for
  that team's org — KTD3 re-join).
- `decideCanvasAccess` `case "team"`: deny if not a member, if `!tenancyActive`, if `orgId===null`,
  or if `!teamMatch`; else honor `expired`+`gate` and allow (full).
- `settings-update`: add `'team'` to the access union; gate `access='team'` on `tenancyActive`+`orgId`
  +≥1 grant (`TEAM_REQUIRED` 409). Grant flow writes `canvas_teams` for **owner-owned teams at grant
  time** (KTD4); grants survive the owner leaving the team.
- Clone seam: team member may clone a `team` canvas (extend the clone-eligibility predicate). Org-wide
  gallery list **unchanged** (strictly team-scoped).
- **Tests:** non-team-member → 404 in serve **and** clone; team member → 200; revoked org member loses
  team access on the next request; grant persists after the owner leaves the team; admin is not a
  bypass; a `team` canvas under inert tenancy / null org → 404.

### U5. Team "my teams" view + dashboard
A **"shared with my teams"** list (viewer's teams via `canvas_teams ⋈ team_members`, with the KTD3
org re-join) — **separate from** the org-wide gallery. Dashboard: team management (create/join, roster)
+ a team picker in the share control showing **only the owner's teams**. ScopeBadge gains a team
variant. **Tests:** the "my teams" listing excludes non-members; the share UI shows only owned teams.

### U6. MCP parity
Tools for team CRUD + membership + the `team` access scope (grant/revoke teams on a canvas) + the
"my teams" read, wrapping the **same service layer** with the same owner/membership checks (a
non-owned id reads as not-found; same audit events). Cross-org-admin team actions stay **off** the
per-account MCP surface (admin routes only). **Tests:** MCP team create/grant honors the same denials.

### U7. Docs parity (R9)
Update the served docs + `/llms.txt` + README: the access ladder gains **Team** between
*Specific people* and *Whole org* (`authoring/sharing.md`); `security-model.md` invariant #3 notes the
new `team` predicate + the KTD3 re-join; `create-and-publish.md` workspace note; the MCP/llms tool
tables gain the team tools. Run `pnpm docs:build` (CI drift gate) + the integrity test.

### U8. Invariant tests + review
End-to-end rejection-first suite for the `team` rung (serve, clone, "my teams" view) + membership
reconciliation; `/ce-code-review` (security + adversarial); fix findings with regression tests; CI
green on **both** dialects.

## Risks / watch-items

- **Stale `team_members` after org-revoke** — the #1 leak. Mitigated two ways: KTD3 read-time re-join
  (a revoked member is denied even with a live `team_members` row) **and** KTD2 reconcile (clean up the
  rows). Test both independently.
- **Grant-time vs read-time membership** — KTD4: the owner needs the team at grant time; grantees are
  validated at read time. Don't conflate (a test pins "grant persists after owner leaves").
- **`access` single-value invariant** — setting `team` must clear any prior `whole_org` scoping and
  vice-versa; the grant set is meaningless unless `access==='team'`. Gate in `settings-update`.
- **Dual-dialect** — four tables × two schemas in lockstep; parity test is the gate (Risk #2).

## Out of scope (later phases)
Cross-domain/invited org members (P4, D8) · per-org RBAC roles (P4) · multiple orgs per instance (P3) ·
org-wide discoverability of team canvases (explicitly declined above).
