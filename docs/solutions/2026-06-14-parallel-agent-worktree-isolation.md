---
title: Parallel-agent isolation — unique worktree naming + .env is not auto-loaded
type: workflow
area: ops
date: 2026-06-14
---

Two gotchas surfaced while running several agents in parallel under the
`/parallel-agent-fixing` flow. Both are about isolation between concurrent agents.
See also [[ci-and-test-infra-gotchas]].

## A bare task slug collides — two agents grab the SAME worktree/branch

`/parallel-agent-fixing` told agents to name their worktree from a task `<slug>`.
Two agents handed the same kind of task ("polish and bug fixing") independently
picked the **same** slug `polish-bugfix`, so the second agent found an existing
`../canvas-drop-polish` worktree on branch `feat/polish-bugfix`, assumed it was a
stale leftover (it had no diff at that instant), and **reused it**. Both agents then
committed to the same branch in the same working directory — their commits
interleaved in the reflog, and one agent's uncommitted WIP sat live in the other's
tree. No file corruption only because the two happened to touch disjoint files.

**Root cause:** "no diff right now" was read as "unowned". An active agent is
routinely *between commits*, so a clean `git status` does not mean the worktree is
free.

**Avoid it:**
- Name worktree + branch with the per-agent instance number `N`, which is unique:
  `feat/<task>-n<N>`, dir `../canvas-drop-<task>-n<N>`. The suffix alone prevents the
  collision.
- Before creating, treat an existing worktree (`git worktree list`) or branch
  (`git branch --list`) with your intended name as a **red flag = another live
  agent**. Do not reuse, reset, or delete it — pick a new unique name and re-check.
- Tripwire during the session: a commit you didn't author in `git log`, or
  uncommitted changes you didn't make in `git status`, means you are sharing a
  worktree. Stop; commit only your own files by explicit path (never `git add -A` /
  `commit -a` / `stash` / `reset` / `checkout`, which touch the other agent's work);
  never `pkill -f` a path pattern that could match their processes.

## `.env` is not auto-loaded — exporting is what actually sets the ports

The quickstart `cp .env.example .env && pnpm dev` is documented as the way to
configure a dev instance, but **nothing in the repo reads the `.env` file**.
`loadConfig` only reads `process.env`, and production injects config via systemd's
`EnvironmentFile=/etc/canvas-drop.env` (see `deploy/`). So `.env` only *appeared* to
work because the boot defaults happen to equal the dev profile — any real value in
`.env` (ports, session secret, admin emails, oidc) was silently dropped.

For parallel agents this bit hardest on ports: setting `CANVAS_DROP_DASHBOARD_PORT`
in `.env` did nothing, so `pnpm dev` booted Vite on the default `5173`, and Vite's
`strictPort` then **crashed the whole `pnpm dev`** when another agent already held
`5173` — taking the server down with it.

**Avoid it:** export the vars on the launch command so they're really in the
environment — `CANVAS_DROP_PORT=… CANVAS_DROP_DASHBOARD_PORT=… pnpm dev` — and after
launching, *confirm* both ports are listening (`lsof`) and the API answers
(`curl /api/me`) rather than assuming success. A dev-only fix that makes `pnpm dev`
load the worktree `.env` (`node --env-file-if-exists=.env`, env-wins-over-file, prod
untouched) is in flight; until it lands on `main`, exporting is the reliable path.

(Aside: `/healthz` is the real health check. A `503` from `/health` in dev is just
the SPA history fallback with no built `dist/` — not a bug.)
