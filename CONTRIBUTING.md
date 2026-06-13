# Contributing to canvas-drop

canvas-drop is built by humans and AI coding agents working together. The same rules apply to both.

## Before you start

- Read **`BUILD_BRIEF.md`** — the locked product spec. It wins any conflict.
- Find the relevant plan in **`docs/plans/`** and the matching GitHub issue. Work flows from plans, not ad-hoc ideas.
- AI agents: read **`AGENTS.md`** and **`docs/agent-workflow.md`** — they define the worktree + issue + compounding loop.

## Workflow

1. One **GitHub issue** tracks each plan/phase, with implementation units (U-IDs) as a checklist.
2. Branch per unit: `feat/u<N>-<slug>`. Agents use isolated git worktrees so parallel work never collides.
3. Implement the unit **with the test scenarios from the plan**. Feature-bearing units must have tests.
4. Open a **PR per unit**, titled `U<N>: <what> (#<issue>)`.
5. CI (lint, typecheck, tests on **both** SQLite and Postgres, build) must pass before merge.
6. Capture anything non-obvious as a learning in `docs/solutions/` (`/ce-compound`) so knowledge compounds.

## Code standards

- TypeScript end-to-end. Biome for lint + format (`pnpm lint`, `pnpm typecheck`).
- **Config is the only `process.env` reader** — everything else takes typed config.
- **Everything behind an interface** — DB, storage, URL mode, auth. Driver choice is config, never code.
- **Dual-dialect parity is mandatory** — keep SQLite and Postgres schemas in lockstep; CI runs both.
- **No secrets in the browser.** **Static-first** canvases. **Org-agnostic** naming; no telemetry.

## Security

The auth gateway and the five security invariants (`BUILD_BRIEF.md` §12.0) are the highest bar. Changes to auth, identity, sharing, or the proxy-trust path get extra review and test-first treatment.
