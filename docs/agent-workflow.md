# Agent workflow

The concrete loop both Claude and Codex follow. `AGENTS.md` is the summary; this is the detail.

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

## Dependency order for the foundation

```
U1 (monorepo) ──┬─> U2 (env) ──┬─> U3 (logging)
                │              ├─> U4 (db) ──┬─> U7 (auth core) ─> U8 (proxy)
                │              │             ├─> U9 (oidc)
                │              │             └─> U10 (audit)
                │              ├─> U5 (storage)
                │              └─> U6 (routing) ─> U7
                └────────────────────────────────> U11 (assembly) ─> U12 (CI)
```

- **U1 is the gate.** Merge it to `main` before anyone starts U2+.
- The auth units (U7/U9/U10) need **U2 and U4** merged first. Watch issue #1 for those landing.
- U11 wires everything; U12 is the CI matrix. Any agent takes them once their inputs exist.

Ownership is **dynamic** — claim whatever unit is free and unblocked. Nothing is reserved for a specific tool.

## Before every unit

1. `git pull` and check issue #1 — is this unit already claimed (assignee / `status:claimed` / recent comment)? If so, pick another.
2. Claim it: comment "taking U<N>" and/or add `status:claimed`.
3. Read the unit in `docs/plans/2026-06-13-001-feat-foundation-config-auth-plan.md`.
4. Skim `docs/solutions/` (or let compound-engineering surface relevant learnings).
5. Confirm your dependency gates are merged, then open your worktree + branch.
