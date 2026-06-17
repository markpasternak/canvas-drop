# AGENTS.md — canvas-drop

> Canonical agent instructions for this repo. `CLAUDE.md` is a symlink to this file, so Claude Code and Codex read the **same** contract. Edit this file, never the symlink.

canvas-drop is an open-source (MIT), self-hostable platform where authenticated org members deploy and share small web artifacts ("canvases"). The locked product spec is **`BUILD_BRIEF.md`** — it supersedes everything when there's a conflict.

---

## How we work (the loop)

Both agents follow the same compound-engineering loop:

1. **Plan** — work comes from a plan in `docs/plans/`. **v1 is feature-complete: M1–M9 are all shipped and merged to `main`** — foundation (M1), hosting + deploy (M2), dashboard core (M3), canvas-management depth (M4), the editor + draft/publish version model on content-addressed storage (M5), the five primitives + browser SDK (M6: KV, files, `me()`, browser SDK), admin + hardening (M7), gallery (M8), and the AI proxy + realtime (M9). Several post-v1 features (the canvas sharing access ladder — guest invites + admin-gated public links, usage stats, server-side list filters, the docs system, clone-as-template, the primitives showcase, owner-chosen custom slugs) are also merged. The only open milestone is **M10 ops/packaging** (BUILD_BRIEF §16: Docker image + compose, backup/restore drill, single-VPS load test, IAP pilot) — plus any in-flight fix plan in `docs/plans/`. Check `BUILD_BRIEF.md §16` and `README.md` Status for current status; don't free-style features that aren't in a plan.
2. **Issue** — each plan/phase has a GitHub issue with the units as a checklist (foundation = #1, C+D = #4, area E = #6, all closed). Tick a unit's box when its PR merges.
3. **Branch in your worktree** — never work in the shared checkout. Branch name: `feat/u<N>-<slug>` (e.g. `feat/u7-auth-core`).
4. **Implement one unit at a time**, with its test scenarios from the plan. Tests are not optional for feature-bearing units.
5. **Capture learnings** — run `/ce-compound` (or write to `docs/solutions/`) whenever you hit something non-obvious: a gotcha, a decision, a pattern, a workflow fix. This is how knowledge compounds across Claude **and** Codex.
6. **PR per unit** — title `U<N>: <what> (#1)`. The CI matrix must be green before merge.
7. **Merge small, merge often** — see "Compounding" below.

Before starting any unit: **`git pull` first** so you see the other agent's merged learnings and code.

---

## Autonomous full-scope rounds (Mark's preferred workflow)

The repo owner (Mark) prefers that, once a plan is approved, an agent **executes the entire plan end-to-end in one go and merges the PR without check-ins.** When running this mode, do not pause for input between units or before merging — work from the approved plan straight through to a merged PR. The loop:

1. **Set up** — commit/announce the plan, open the tracking issue, branch (`feat/<plan-slug>`).
2. **Build every unit** in dependency order, one local commit per unit, each unit's gates green (`typecheck`, `lint`, full dual-dialect `test`) before moving on. The plan groups the whole scope into one branch / one PR (not PR-per-unit) for autonomous rounds.
3. **Self-review** as you go; fix obvious issues immediately.
4. **Multi-agent code review** — run `/ce-code-review` on the branch before the PR. **Fix everything real it finds** — P0/P1 and high-value P2 — with regression tests. **Weight findings against the trust model** (`docs/solutions/2026-06-13-auth-invariant-checklist.md` → "Calibrate to the trust model"): §12.0 hard-invariant bugs are P0; right-size hostile-internet findings on non-invariant surfaces.
5. **Ship** — push, open the PR, wait for the CI matrix to go green (fix any red), then **merge it** (squash, delete branch). The autonomous merge is authorized once: all units done + full suite green on both dialects + code review run and findings fixed + CI green on the PR.
6. **Close out** — close the issue, capture learnings in `docs/solutions/`, update the active-plan pointers, leave `main` green.

The safety net for the autonomous merge is the CI matrix (the explicit, authoritative gate) + the completed code review — not a human gate, and not an implicit local hook. Server-side branch protection arrives when the repo goes public / on Pro.

**This is the default for plan-driven rounds on this repo unless Mark says otherwise.** A single round may span many units, a full review, and the merge — all without interruption.

---

## Parallel work (optional — you may be running solo, or alongside other agents)

You might be the only agent on this repo, or one of several running at once (Codex + Claude, or even two Claudes). The rules below make any of those safe — they cost nothing when you're solo and prevent collisions when you're not. **Don't assume another agent is active; don't assume one isn't.**

**One worktree per running agent instance, one unit per branch.** Never edit the shared checkout directly while doing unit work:

```
canvas-drop/              # main (protected; CI required to merge)
../canvas-drop-<branch>/  # your worktree for the unit you're on
```

Create one with `git worktree add ../canvas-drop-u<N> -b feat/u<N>-<slug>` (or `/ce-worktree`). Name worktrees by the unit/branch, not by tool — that way two Claudes don't clash.

**Claim before you start, so no two instances grab the same unit:**

1. `git pull` and check the active plan's tracking issue — is the unit already claimed (assignee, `status:claimed` label, or a recent "taking U<N>" comment)?
2. If free, claim it: comment "taking U<N>" on the issue and/or add the `status:claimed` label. Pick any unit whose dependency gates are merged — ownership is **dynamic**, not pre-assigned to any tool.
3. Open your worktree + branch and go.

**Dependency gates (these constrain order regardless of who runs what):**

- **U1 (monorepo) blocks everything** — merge it to `main` before any other unit starts. The first step is unavoidably sequential.
- **Auth units (U7/U9/U10) need U2 (env config) and U4 (DB) merged first** — they read config and the `users`/`sessions`/`audit_log` tables.
- **U6 (routing) → U7 (auth core) → U8 (proxy) / U9 (oidc)**; U8 and U9 parallelize once U7's interface exists.
- **U11 (assembly)** needs U2–U10; **U12 (CI)** needs something to test (depends on U4 for the dialect split).
- Anything without a pending gate is fair game to claim in parallel (e.g. U5 storage alongside U6 routing).

If you're working solo, ignore the claiming ceremony and just follow the dependency order.

---

## Compounding learnings across every agent

Learnings live in **git**, not in any agent's private memory:

- An agent's per-session/per-project private memory is **not shared** — another Claude or Codex instance can't read it. Never put shared knowledge there.
- The shared brain is `docs/solutions/` (learnings), `docs/plans/` (plans), `docs/brainstorms/` (requirements). Every agent reads these via compound-engineering before working and writes to them after.
- Because they're git-tracked, **learnings compound at merge/pull cadence.** Keep PRs small, merge to `main` often, and `git pull` before each unit so other instances' lessons are already in your context.

---

## Project rules (load-bearing — from BUILD_BRIEF.md)

- **Config is the only `process.env` reader.** Everything else takes typed config (§8.1). No scattered env access.
- **Everything behind an interface**: DB (SQLite↔Postgres), storage (local↔S3), URL mode (path↔subdomain), auth (proxy↔oidc↔dev). Swapping a driver is a config change, never a code change.
- **Dual-dialect is sacred** (Risk #2). `pgTable` and `sqliteTable` are separate compile-time builders — keep `schema.pg.ts`/`schema.sqlite.ts` in lockstep via shared column helpers; code against shared inferred types; the schema-parity test + CI matrix must stay green on **both** dialects.
- **Auth is invariant-critical** (§12.0, §12.5). Identity always comes from the server-side auth context, never the client. In `proxy` mode, only the trusted proxy may assert identity (verify JWT, or trust headers solely from `CANVAS_DROP_TRUSTED_PROXY_IPS`). Test the spoofing-rejection paths first.
- **No secrets in the browser, ever.** AI provider keys and canvas API keys are server-side only.
- **Static-first.** Canvases are static files; no build step server-side. Backend capability only via the five primitives (KV, files, AI, identity, realtime).
- **Agent-native parity.** Anything a user can do in the dashboard UI, an agent must be able to do over the **MCP**. A new owner-facing capability is not "done" until its MCP tool ships alongside the UI. MCP tools **wrap the same service layer** the HTTP/management routes use — never a parallel implementation — and carry the same `requireOwned` owner check (a non-owned id reads as *not found*, §12.0) and the same audit events. (Admin-only cross-owner actions are the exception: they live on the dedicated admin routes, not the per-account MCP surface.)
- **Org-agnostic.** No organization-specific naming, branding, or telemetry/phone-home. MIT, 12-factor.

---

## Key paths

- `BUILD_BRIEF.md` — the spec (authoritative).
- `docs/plans/` — implementation plans (start here for any unit).
- `docs/solutions/` — compounding learnings.
- `docs/agent-workflow.md` — the full loop, branch naming, worktree commands.
- `apps/server`, `apps/dashboard`, `packages/shared`, `packages/sdk` — the workspace (created in U1).

## Commands

```
pnpm install        # resolve workspace (approves native builds via pnpm-workspace.yaml)
cp .env.example .env && pnpm dev   # logged-in instance on localhost (path+sqlite+local+dev)
pnpm test           # vitest — runs BOTH dialects in-process (sqlite + pglite)
pnpm test:sqlite    # sqlite leg only (sets CANVAS_DROP_DB)
pnpm test:pg        # postgres leg only
pnpm lint           # biome check
pnpm format         # biome check --write . (fixes + sorts imports); `pnpm lint` (biome check .) only reports
pnpm typecheck      # tsc --noEmit
pnpm build          # build all workspace packages (sdk, dashboard, server) via `pnpm -r build`
```

## Before pushing / merging

- **CI must be green on both dialects before merge.** The matrix (`.github/workflows/ci.yml`)
  runs lint, typecheck, test-sqlite, test-postgres (+ real Postgres/MinIO), and build.
  CI is the **explicit, authoritative gate** — there is no local pre-push hook.
- **Gate yourself explicitly before pushing:** run `pnpm lint && pnpm typecheck && pnpm test`
  yourself (don't rely on an implicit hook). CI re-runs the full matrix on the PR, in a
  clean environment, and that green is what authorizes the merge. Server-side branch
  protection arrives when the repo goes public (BUILD_BRIEF OPEN-8) or on Pro.

## Read first when working in these areas

Institutional learnings live in `docs/solutions/` — skim the index, and especially:

- **Any auth / permissions / proxy / session / config-guard work** → read
  `docs/solutions/2026-06-13-auth-invariant-checklist.md` first. It lists the §12 failure
  modes a review caught past green tests, with a reusable checklist. Run `/ce-code-review`
  before opening a PR on auth/payment/migration-shaped changes.
- **Anything touching the DB / dual-dialect schema** → `…dual-dialect-drizzle-seam.md`.
- **CI / test infra changes** → `…ci-and-test-infra-gotchas.md`.
