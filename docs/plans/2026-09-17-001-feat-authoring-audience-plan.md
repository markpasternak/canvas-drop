---
title: Authoring audience
type: feat
date: 2026-09-17
issue: 125
---

# Authoring audience

**Goal.** Let a canvas limit page-driven authoring (`canvasdrop.canvases`: publish, update,
list, revoke) to its owners and editors, the way AI and Connections already have an audience.

**Decision.** Mirror `aiAudience`/`connectionsAudience` as `authoringAudience`, stored on the
canvas, but default it to `viewers`: every admitted member could author before, and an
upgrade must not silently remove that from existing canvases. `editors` is the opt-in.

**Units (one branch, one PR).**
1. Column + migrations on both dialects; `runtimePermissions` computes `canCreateCanvas`
   from the audience so `me()` tells canvas code the truth before it tries.
2. `/v1/c/:slug/authoring` checks the audience after the capability gate on every
   operation and answers `403 PERMISSION_DENIED` (the SDK's `PermissionDeniedError`).
3. Management `PATCH /capabilities`, MCP `set_capabilities` and the tool-kit echo, the
   admin inspector, and the dashboard Backend tab ("Authoring access").
4. Docs (capabilities, permissions, authoring, identity, runtime API, MCP, llms, skill),
   `BUILD_BRIEF`, project status; regenerated bundled docs.
5. Tests: route audience (viewer refused on all four operations, owner kept), `me()`
   permission, MCP echo, dashboard control; existing fixtures gain the column.

**Rollout.** Deploy, then set `authoringAudience: editors` on the SeenThis roadmap canvas
from its Backend tab. The roadmap app already gates its Share UI on `me().canvasRole`.
