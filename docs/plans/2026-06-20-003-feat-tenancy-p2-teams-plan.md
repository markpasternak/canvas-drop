---
title: "feat: Tenancy Phase 2 — teams (intra-org sharing groups)"
type: feat
date: 2026-06-20
origin: docs/brainstorms/2026-06-20-multi-tenant-org-isolation-requirements.md
status: draft
reviewed: 2026-06-20
depth: moderate
phase: 2
depends_on: docs/plans/2026-06-20-002-feat-tenancy-p1-org-boundary-plan.md
invariant_critical: true
---

# feat: Tenancy Phase 2 — Teams (8 units)

> **Depends on Phase 1** (org boundary, the DI membership resolver, the three-seam re-scope).
> Re-verify the P1 interfaces before deepening this. Invariant-critical: the `team` rung is a new
> authorization predicate (across the same three seams) → `/ce-code-review` (security + adversarial)
> gates the PR.

## Summary

Add **teams**: members-only groups inside an org, **self-serve** (any member creates a team and
invites other members — D6). A canvas owner can scope a canvas to one or more of their teams via the
`team` rung (reserved in P1's CHECK, implemented here), slotted between `specific_people` and
`whole_org`. Phase 2 also introduces **explicit membership rows** (`org_members`) so P1's *derived*
membership becomes *derived ∪ explicit* behind the same resolver — and adds the **reconciliation**
that revokes stale membership (org **and** team) when a domain is removed (R13, partial).

## Problem Frame

Phase 1 gives "my whole org"; teams give "the subset I actually collaborate with." Teams are the
grouping the user explicitly asked for ("within an organization you can have multiple teams who
share stuff").

## Requirements Traceability

| Requirement | Units |
|---|---|
| R9 Teams (model, self-serve, `team` rung, gallery, MCP **+ docs**) | U1–U6, U7 (docs) |
| R13 Lifecycle reconciliation (org + team) | U2 |
| R-sec Invariant tests | U2, U4, U8 |

## Key Technical Decisions

- **KTD1 — Explicit membership, materialized at login; no invite source yet.** `org_members(org_id,
  user_id, role, source)` with `source = 'domain'` only in P2 (an `'invite'`/cross-domain-member flow
  is **not** planned here — D8 defers it, so no code writes it; don't ship a `source` value nothing
  creates). The P1 DI resolver is **extended** to *materialize* a `source='domain'` row on login
  (idempotent upsert) alongside returning the set — the resolver interface from P1/U3 is unchanged
  for callers; only its body now writes-then-unions. (Requires U1's schema first.)
- **KTD2 — Reconciliation cascades org → team.** When the operator removes a domain, revoke
  `source='domain'` `org_members` rows for it **and** cascade-revoke those users' `team_members` rows
  — otherwise a now-outsider keeps team-canvas access (a real leak). One tested reconcile step; a
  dry-run delta like the cutover.
- **KTD3 — Teams belong to exactly one org; members-only.** `teams(org_id, name, slug, created_by)`,
  `team_members(team_id, user_id, role)`. A `team_members.user_id` must have a live `org_members` row
  for the team's org — enforced at write **and** re-checked at read (the `team` rung re-joins
  `org_members`, so a revoked member can't ride a stale `team_members` row).
- **KTD4 — `team` rung via a grant table.** `canvas_teams(canvas_id, team_id)`: `access = 'team'`
  means "a member of any granted team." Supports "my team(s)" (plural). The owner may grant only
  teams they belong to **at grant time**; the grant is then **independent of the owner's continued
  team membership** (the canvas was shared *to* the team — grantees stay legitimate org+team members).
  `access` stays single-valued — `team` and `whole_org` don't co-exist on one canvas.
- **KTD5 — `role` is a placeholder in P2.** `org_members.role` and `team_members.role` exist but P2
  writes only `'member'` (and treats `created_by` as the de-facto manager). The `{owner, admin,
  member}` enumeration + semantics land in **P4** (per-org governance). P2 management actions
  ("creator or org owner") mean **creator-or-instance-operator** until then.
- **KTD6 — The `team` CHECK value is already reserved (P1/KTD5), so adding the `team` rung needs NO
  CHECK migration** — P1 paid that cost. P2's schema is purely additive (the four new tables).
  Generate dual-dialect migrations; parity test green.

## Implementation Units

### U1. Schema — `org_members`, `teams`, `team_members`, `canvas_teams`
Additive tables (the `access` `'team'` value already exists from P1). Dual-dialect migrations;
parity test green. (No `canvases` CHECK change — reserved in P1.) FK order documented.

### U2. Explicit membership (materialize-at-login) + reconciliation
Extend the P1 resolver to upsert a `source='domain'` `org_members` row on login and return
`derived ∪ explicit` (trivially derived-only until any future explicit source). Add the reconcile
routine: on domain removal, revoke `source='domain'` org rows **and** cascade `team_members`.
**Tests:** union correctness; domain-removal revokes org **and** team access on the next request
(rejection-first); server-only as in P1.

### U3. Team service + self-serve CRUD
`teamsRepository` + a team service: create (any member), rename/delete (creator or instance
operator — KTD5), invite/remove member (same-org members only). Management routes + audit events
(`team_create`, `team_member_add`, …). **Tests:** a guest cannot create/join; a member of org A
cannot be added to an org-B team; rejection-first.

### U4. `team` rung in the three seams + canvas→team grants
`access = 'team'` honored via `canvas_teams` in `decideCanvasAccess` (serve) **and** the shared
list/clone predicate (gallery/clone seam) — a non-team-member sees a `team` canvas in none of serve,
gallery, or clone. The `team` read check re-joins `org_members` (KTD3). Owner grants only their own
teams at grant time. **Tests:** non-team-member → 404; team member → 200; revoked org member loses
team access immediately; grant persists after the owner leaves the team; admins not a bypass.

### U5. Team gallery + dashboard
A team filter on the org gallery + a "shared with my teams" view; dashboard team management
(create/join, roster) and a team picker in the share control (only the owner's teams). **Tests:**
team-scoped listing excludes non-members; share UI shows only owned teams.

### U6. MCP parity
Tools for team CRUD + membership + the `team` access scope + the team-gallery read, wrapping the
same service layer with the same checks. Cross-org-admin team actions stay off the per-account MCP
surface.

### U7. Docs parity (R9)
Update `/docs`, `/llms.txt`, and the README sharing/access section for teams + the `team` rung +
team MCP tools (R9's "docs parity" deliverable — owner-facing capability ⇒ docs update).

### U8. Invariant tests + review
End-to-end rejection-first suite for the `team` rung (all three seams) + membership reconciliation;
`/ce-code-review` (security + adversarial); fix findings with regression tests; CI green both
dialects.

## Open questions (resolve when planning at depth)

- Team **roles** (member vs lead) — needed now, or flat (KTD5 placeholder) until P4's RBAC?
  (Default: flat; creator + operator manage.)
- Should a `team` canvas also be discoverable org-wide (a highlight), or strictly team-scoped?
  (Default: strictly `team`; `access` is single-valued.)
