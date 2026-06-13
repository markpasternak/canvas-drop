# Agent workflow

The concrete loop both Claude and Codex follow. `AGENTS.md` is the summary; this is the detail.

## Status

The **foundation** (config, abstractions, auth gateway, audit, CI) is **done** — issue #1
closed, plan `2026-06-13-001-feat-foundation-config-auth-plan.md` complete, merged to `main`.
Next up: **areas C (canvas hosting) + D (deploy pipeline)** — write the plan with `/ce-plan`,
open its tracking issue, then resume the loop below. The foundation round's learnings are in
`docs/solutions/` — read the relevant ones before starting (see AGENTS.md "Read first").

## The loop, step by step

```
plan (docs/plans/)  →  issue (GitHub, U-IDs)  →  worktree + branch
      →  implement one unit (+ its tests)  →  /ce-compound any learning
      →  PR "U<N>: ... (#<issue>)"  →  CI green  →  merge to main
      →  next agent git pulls  →  repeat
```

## Worktrees

You may be solo or running several agents at once (Codex + Claude, or two Claudes). Either way, do unit work in a dedicated worktree named by the **branch/unit**, not by tool — so multiple instances never collide:

```bash
# from the main checkout — one worktree per unit you're working on
git worktree add ../canvas-drop-u1 -b feat/u1-monorepo-scaffold
git worktree add ../canvas-drop-u7 -b feat/u7-auth-core

# list / remove
git worktree list
git worktree remove ../canvas-drop-u1
```

`/ce-worktree` automates this if you prefer. Solo? You can skip worktrees and just branch — they only matter when more than one agent is live.

## Branch naming

`feat/u<N>-<short-slug>` — e.g. `feat/u4-db-factory`, `feat/u8-proxy-jwt`. One branch per unit; one PR per branch.

## Commits & PRs

- Commit subject references the unit: `U3: pino logging + correlation IDs`
- PR title: `U3: structured logging (#1)` — the `#1` auto-links the foundation issue.
- PR body: what changed, which test scenarios were implemented, and "Learning captured? yes/no (link)".
- Tick the unit's checkbox in issue #1 when the PR merges.

## When to run `/ce-compound`

Capture a learning whenever you hit something the next agent (or future you) would want to know:
- a non-obvious bug + root cause (e.g. a SQLite/Postgres dialect difference that bit you)
- a design decision and why
- a convention worth repeating
- a workflow friction and its fix

It writes to `docs/solutions/` with frontmatter so `ce-learnings-researcher` surfaces it before related work. **This is the compounding mechanism — use it generously.**

## Dependency order

Each plan's units carry explicit `Dependencies:` (by U-ID) and the plan's
High-Level Technical Design shows the graph. The rule that held in the foundation
round and generalizes:

- The **scaffold/contract unit is the gate** — merge it to `main` before fan-out
  (foundation: U1 monorepo; future rounds: whatever defines the shared types/interfaces).
- Units that **read another unit's tables or interface** wait for it to merge.
- Independent units (no shared `Files:`) are fair to claim in parallel.

*(Foundation reference graph, now complete: U1 → U2/U3 → U4 → U6 → U7 → U8/U9/U10; U5
alongside; U11 assembles U2–U10; U12 is CI.)*

## Before every unit

1. `git pull` and check the **active plan's tracking issue** — is this unit already
   claimed (assignee / `status:claimed` / recent comment)? If so, pick another.
2. Claim it: comment "taking U<N>" and/or add `status:claimed`.
3. Read the unit in the active plan under `docs/plans/`.
4. **Read the relevant `docs/solutions/` learnings** (see AGENTS.md "Read first" — auth work
   especially has a required checklist), or let compound-engineering surface them.
5. Confirm your dependency gates are merged, then open your worktree + branch.
