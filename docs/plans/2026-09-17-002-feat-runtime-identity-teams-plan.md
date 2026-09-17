---
title: Teams in the runtime identity
type: feat
date: 2026-09-17
---

# Teams in the runtime identity

**Goal.** Let canvas code tailor its interface per team: `me().teams` lists the teams on
this canvas's people-and-teams list the caller belongs to, each with the grant's role.

**Decisions.**
- Scoped both ways: only the caller's own memberships (per-caller response), and only
  teams granted on this canvas, so a page never learns about unrelated teams.
- Same membership-mandatory live-org clause as `teamMatch`: a stale membership never
  surfaces a team the caller can no longer use.
- A UI hint, like `permissions`. Data that must stay private belongs in a resource whose
  policy withholds it; a later plan may add team-scoped resource rights.
- Legacy guests get `[]`; so do owners and members with no team grant here.

**Units (one branch, one PR).**
1. `listCanvasTeamGrantsForUser` on the teams repository.
2. `/v1/c/:slug/me` projects `teams`, sorted by name; SDK `Me.teams`.
3. Docs: identity, teams guide, llms, skill, BUILD_BRIEF, project status.
4. Tests: granted teams with roles (editor grant also lifts `canvasRole`), ungranted
   membership excluded, owner without grants and guest get `[]`.
