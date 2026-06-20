---
title: "feat: Tenancy Phase 2 — teams (intra-org sharing groups)"
type: feat
date: 2026-06-20
origin: docs/brainstorms/2026-06-20-multi-tenant-org-isolation-requirements.md
status: draft
depth: moderate
phase: 2
depends_on: docs/plans/2026-06-20-002-feat-tenancy-p1-org-boundary-plan.md
invariant_critical: true
---

# feat: Tenancy Phase 2 — Teams (7 units)

> **Depends on Phase 1** (org boundary, the membership resolver, the `decideCanvasAccess` seam).
> Re-verify the P1 interfaces before deepening this. Invariant-critical: the `team` rung is a new
> authorization predicate → `/ce-code-review` (security + adversarial) gates the PR.

## Summary

Add **teams**: members-only groups inside an org, **self-serve** (any member creates a team and
invites other members — D6). A canvas owner can scope a canvas to one or more of their teams via a
new `team` rung in the access ladder, slotted between `specific_people` and `whole_org`. Phase 2
also introduces **explicit membership rows** (`org_members`), so the P1 *derived* membership becomes
*derived ∪ explicit* — the foundation for future invited cross-domain members and for team rosters.

## Problem Frame

Phase 1 gives "my whole org"; teams give "the subset I actually collaborate with." Without teams,
every intra-org share is all-or-nothing (private/specific-people or the whole org). Teams are the
grouping the user explicitly asked for ("within an organization you can have multiple teams who
share stuff").

## Requirements Traceability

| Requirement | Units |
|---|---|
| R9 Teams (model, self-serve, `team` rung, gallery, MCP) | U1–U6 |
| R-sec Invariant tests | U2, U4, U7 |

## Key Technical Decisions

- **KTD1 — Explicit membership lands now.** `org_members(org_id, user_id, role, source)` where
  `source ∈ {domain, invite}`. The P1 resolver returns `derived ∪ explicit`. **Reconciliation:**
  when the operator removes a domain, `source=domain` memberships for that domain are revoked;
  `source=invite` persist. Keep this a single, tested reconcile step.
- **KTD2 — Teams belong to exactly one org.** `teams(org_id, name, slug, created_by)`,
  `team_members(team_id, user_id, role)`. Members-only: a `team_members.user_id` must be an
  `org_members` row of the team's org (enforced server-side). Guests can never be added.
- **KTD3 — `team` rung via a grant table, not a single column.** A canvas can be shared to one or
  more of the **owner's** teams: `canvas_teams(canvas_id, team_id)`. `access = "team"` means "any
  member of a granted team." This supports "my team(s)" (plural) cleanly and avoids a nullable
  `team_id` that can't express multiple. The owner may only grant teams they belong to.
- **KTD4 — One seam, again.** `decideCanvasAccess` gains `team` ⇒ `viewer ∈ team_members of any
  canvas_teams[canvas]`. No parallel guard. Order in the ladder: private → specific_people → team →
  whole_org → public_link.
- **KTD5 — Additive dual-dialect migrations** (both dialects, parity test, backup-order updated).

## Implementation Units

### U1. Schema — `org_members`, `teams`, `team_members`, `canvas_teams` + `team` enum
Additive tables + the `team` value added to the `access` enum; migrations both dialects;
`BACKUP_TABLE_ORDER` updated (FK order: org_members/teams after orgs+users; team_members after
teams; canvas_teams after canvases+teams). Schema-parity + backup-order tests green.

### U2. Explicit membership + reconciliation
Materialize `org_members` (`source=domain`) at login alongside the derived set; the resolver
returns the union. A reconcile routine revokes stale `source=domain` rows when a domain is removed.
**Tests:** union correctness; domain-removal revokes derived-but-not-invite; server-only as in P1.

### U3. Team service + self-serve CRUD
`teamsRepository` + a team service: create (any member), rename/delete (creator or org owner),
invite/remove member (members of the same org only). Management routes + audit events
(`team_create`, `team_member_add`, …). **Tests:** a guest cannot create/join; a member of org A
cannot be added to an org-B team; rejection-first.

### U4. `team` rung in `decideCanvasAccess` + canvas→team grants
`access = "team"` honored via `canvas_teams`; owner grants only their own teams; viewer allowed iff
in a granted team. **Tests:** non-team member → 404; team member → 200; owner always; removing a
team grant immediately drops access; admins not a bypass.

### U5. Team gallery + dashboard
A team filter on the org gallery + a "shared with my teams" view; dashboard team management
(create/join, roster) and a team picker in the share control (only the owner's teams). **Tests:**
team-scoped listing excludes non-members; share UI shows only owned teams.

### U6. MCP parity
Tools for team CRUD + membership + the `team` access scope, wrapping the same service layer with
the same checks (owner/member). Cross-org-admin team actions stay off the per-account MCP surface.

### U7. Invariant tests + review
End-to-end rejection-first suite for the `team` rung and membership reconciliation; `/ce-code-review`
(security + adversarial); fix findings with regression tests; CI green both dialects.

## Open questions (resolve when planning at depth)

- Team **roles** (member vs lead) — needed now, or flat until Phase 4's RBAC? (Default: flat;
  creator can manage.)
- Should `whole_org` and `team` **co-exist** on one canvas (org-wide *and* a team highlight), or is
  access single-valued? (Default: single-valued `access`; `canvas_teams` only populated when
  `access = "team"`.)
