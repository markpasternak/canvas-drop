---
title: "Tenancy P1: the inert/active gate, and a hono in-process test red herring"
date: 2026-06-21
tags: [auth, tenancy, testing, hono, gotcha]
area: [auth, realtime, testing]
---

# Tenancy Phase 1 — two non-obvious things

## 1. `whole_org` re-scope must be gated on "tenancy active", not unconditional

The plan said two things that look contradictory:

- **U4 truth table:** `whole_org` + `org_id IS NULL` → 404 (an explicit deny; the cutover
  clamps these guest-owned rows).
- **Rollout:** "merge behind the additive schema — **inert until config names an org**;
  clearing org_id restores prior behavior."

If you make `decideCanvasAccess` deny `whole_org`+null **unconditionally**, deploying the
code instantly breaks every existing `whole_org` canvas (all `org_id` null pre-cutover) —
the opposite of "inert".

The reconciliation: gate the re-scope on **`ctx.tenancyActive`** (= `!!config.org.name`).

- **Inert** (no org configured): `whole_org` keeps the legacy "any signed-in member" meaning;
  `org_id` is ignored. Deploying changes nothing.
- **Active** (an org configured): `whole_org` = member of the canvas's home org; `org_id`
  null is an explicit deny (and the cutover clamps guest-owned rows).

This flag has to be threaded to **every** seam that evaluates `whole_org`, or one seam lags
and you get a split-brain bypass: `canvasAccess` middleware, `canvas-api`, the realtime hub,
`galleryVisibilityFilters` (list/facets/trending), `findCloneableTemplate` (clone), the
settings `ORG_REQUIRED` guard, and the MCP equivalents. All derive it from `config.org.name`.
The same gate is why the settings route must reject `whole_org` on a null-org canvas **only**
when active (inert still allows it).

## 2. A hono in-process `app.request()` test can report a stale `.status` — read the body

While writing the end-to-end serve-seam test, a denied cross-org member appeared to receive
**200 + the canvas content** — alarmingly like an auth bypass. It was not. Two traps stacked:

1. **`app.request()` (in-process) + an undrained streamed response body** → a later request
   can read a **stale `.status`** (200) even though the server sent 404. The **response body
   is always correct** (`{"error":"not_found"}`). Fix: assert on the body, or drive the test
   over a **real socket** via `h.listen()` + `fetch` (each request is fully independent).
2. **The scenario harness `headerStrategy` defaults a no-`x-test-user` request to `OWNER`** —
   so a test's "anonymous" case is actually a valid member. The "leak" was OWNER (an org
   member) correctly getting 200. There is no real anonymous path through this harness for
   the canvas surface; test cross-org-member and guest denials instead.

Lesson: when an integration test looks like it found a §12 bypass, **verify the decision at
the source** (a debug header on `canvasAccess` showed `decision=deny` the whole time) before
believing the harness. The unit truth table for `decideCanvasAccess` was right all along.

See `apps/server/src/integration/tenancy-scenarios.test.ts` (real-socket serve test) and
`apps/server/src/canvas/authorization.ts` (the `tenancyActive` gate).
