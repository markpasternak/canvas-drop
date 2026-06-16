# Contributing to canvas-drop

canvas-drop is built by humans and AI coding agents working together. The same rules apply to both. It's early, and outside contributions are genuinely welcome.

## Found a bug, or have an idea? (start here)

You don't need to be plugged into the plan loop to help. For a bug, a docs fix, or a small improvement:

1. **Open an issue first** — a [bug report](.github/ISSUE_TEMPLATE/bug-report.md) or a [feature request](.github/ISSUE_TEMPLATE/feature-request.md). For anything beyond a trivial fix, a quick discussion saves a wasted PR.
2. **Get it running locally** — see the [README quickstart](README.md#quickstart-local-dev): `pnpm install && cp .env.example .env && pnpm dev`.
3. **Open a PR against `main`** with a clear title and a link to the issue. A small external PR **does not** need a plan or a `U<N>` id — that convention (below) is for the internal plan-driven loop, not for drive-by fixes.
4. Be kind — see the [Code of Conduct](CODE_OF_CONDUCT.md).

**Security issues:** please do **not** open a public issue — see [`SECURITY.md`](SECURITY.md) for private disclosure.

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE) (inbound = outbound).

---

The rest of this doc describes the **plan-driven loop** that humans and AI agents follow for larger, tracked work.

## Before you start

- Read **`BUILD_BRIEF.md`** — the locked product spec. It wins any conflict.
- Find the relevant plan in **`docs/plans/`** and the matching GitHub issue. Substantial, tracked work flows from plans — small external fixes (above) don't need one.
- AI agents: read **`AGENTS.md`** and **`docs/agent-workflow.md`** — they define the worktree + issue + compounding loop.

## Workflow

1. One **GitHub issue** tracks each plan/phase, with implementation units (U-IDs) as a checklist.
2. Branch in an isolated git worktree so parallel work never collides. Branch name `feat/u<N>-<slug>` for a single unit, or `feat/<plan-slug>` when a whole approved plan ships on one branch.
3. Implement **with the test scenarios from the plan**, one unit at a time. Feature-bearing units must have tests.
4. Open a **PR** titled `U<N>: <what> (#<issue>)`. PR-per-unit is the default; an approved plan run end-to-end may ship its whole scope as one branch / one PR.
5. CI (lint, typecheck, tests on **both** SQLite and Postgres, build) must pass before merge.
6. Capture anything non-obvious as a learning in `docs/solutions/` (`/ce-compound`) so knowledge compounds.

## Gate yourself before pushing

CI is the authoritative gate — there is no local pre-push hook. Run the full gate yourself first:

```
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` runs **both** dialects in-process (SQLite + PGlite). CI re-runs the full matrix (lint, typecheck, test-sqlite, test-postgres against real Postgres/MinIO, build) on the PR, and that green is what authorizes the merge.

## Code standards

- TypeScript end-to-end. Biome for lint + format (`pnpm lint`, `pnpm format`, `pnpm typecheck`).
- **Config is the only `process.env` reader** — everything else takes typed config.
- **Everything behind an interface** — DB, storage, URL mode, auth. Driver choice is config, never code.
- **Dual-dialect parity is mandatory** — keep SQLite and Postgres schemas in lockstep; CI runs both.
- **No secrets in the browser.** **Static-first** canvases. **Org-agnostic** naming; no telemetry.

## Security

The auth gateway and the §12.0/§12.5 invariants (`BUILD_BRIEF.md`) are the highest bar: identity always comes from the server-side auth context, never the client; in `proxy` mode only the trusted proxy may assert identity (verified JWT, or headers trusted solely from `CANVAS_DROP_TRUSTED_PROXY_IPS`). Changes to auth, identity, sharing, or the proxy-trust path get extra review and test-first treatment — run `/ce-code-review` before opening the PR, and read `docs/solutions/2026-06-13-auth-invariant-checklist.md` first.
