# Testing

For contributors: how to run the suite, how to write a test that proves a change on both database dialects, and what CI checks before a merge. Gate yourself before you push. There is no local pre-push hook; the CI matrix on the PR is the authoritative gate, and server-side branch protection on `main` requires it.

```
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` runs the root suite on **both** database dialects in one process (in-memory SQLite and in-process pglite), then the dashboard suite, and stops at the first failing phase. CI re-runs the same matrix in a clean environment; that green is what authorizes a merge. Requires Node `>=24` and `pnpm@11.0.9` (pinned in `package.json`; `corepack enable` picks it up).

## Commands

```
pnpm test                                        # full suite: root (both dialects), then dashboard
pnpm test:sqlite                                 # root suite, CANVAS_DROP_DB=sqlite only
pnpm test:pg                                     # root suite, CANVAS_DROP_DB=postgres only
pnpm test:dashboard                              # dashboard/jsdom suite only
pnpm test:file apps/server/src/db/db.test.ts     # one file, single worker, verbose
pnpm test:watch                                  # bare `vitest` watch mode, root config
```

Everything except `test:watch` goes through `scripts/test-runner.mjs` (see "Parallel-agent test hygiene"). `test:file` accepts several paths and extra Vitest flags (`-t "pattern"`, `--reporter=dot`); a leading `--` is stripped, so `pnpm test:file -- <path>` works too. It picks the dashboard config automatically when a path is under `apps/dashboard/`, and adds `--reporter=verbose` unless you pass a reporter yourself.

## Where tests live

| Suite | Config | Picks up | Environment |
|-------|--------|----------|-------------|
| root | `vitest.config.ts` | `{apps,packages}/*/src/**/*.test.ts`, `scripts/*.test.mjs` | `node`; `testTimeout` and `hookTimeout` 20 s |
| dashboard | `apps/dashboard/vitest.config.ts` | `apps/dashboard/src/**/*.test.tsx` | `jsdom`, `src/test/setup.ts`, `css: false` |

The extension chooses the suite, not the directory: a `.test.ts` anywhere under `apps/*/src` or `packages/*/src` (including `apps/dashboard/src`) runs in the root Node suite; a `.test.tsx` runs in jsdom. Write a React test as `.test.tsx` under `apps/dashboard/src/test/`; write a server, shared, or SDK test as `.test.ts` next to the code it covers. `pnpm typecheck` also compiles the dashboard tests (`apps/dashboard/tsconfig.test.json`), so a type error in a test fails the `lint` job.

## Dual-dialect is the point

canvas-drop runs on **SQLite or Postgres** from one schema (BUILD_BRIEF.md §10, Risk #2). Every DB test runs against both on a bare `pnpm test`, through `makeTestDb(dialect)` in `apps/server/src/db/testing.ts`:

- **SQLite**: `better-sqlite3`, a fresh in-memory database per call, `foreign_keys = ON`.
- **Postgres**: `pglite`, the real PostgreSQL engine compiled to WASM, in-process. No server needed. One migrated instance is shared per Vitest worker and every `public` table is truncated on each `makeTestDb` acquire, so a test starts clean whether or not the previous one called `close()` (`close()` is a no-op on the shared instance). Use `makeFreshPgTestDb()` only when a test must observe a clean migration apply; the caller owns its `close()`.

Both run the **actual generated migrations** from `drizzle/sqlite` and `drizzle/pg` (located by walking up from the cwd, so tests work from the repo root or `apps/server`), so a migration that breaks on one dialect fails the suite immediately. It also means a schema-only change never reaches the test DB: after editing `schema.pg.ts` / `schema.sqlite.ts`, generate a migration for both dialects and commit `drizzle/pg/*` and `drizzle/sqlite/*`:

```
npx drizzle-kit generate --config=drizzle.pg.config.ts --name=<slug>
npx drizzle-kit generate --config=drizzle.sqlite.config.ts --name=<slug>
```

### Writing a dual-dialect test

Parameterize with `DIALECTS` and build the DB inside the test body, so the 20 s `testTimeout` covers the migration (from `apps/server/src/db/db.test.ts`):

```ts
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "./factory.js";
import { usersRepository } from "./repositories/users.js";
import { DIALECTS, makeTestDb } from "./testing.js";

describe.each(DIALECTS)("db [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("round-trips epoch-ms timestamps as numbers", async () => {
    client = await makeTestDb(dialect);
    const u = await usersRepository(client).upsert({
      providerSub: "sub-1",
      email: "a@example.com",
      name: "A",
      isAdmin: false,
    });
    expect(typeof u.createdAt).toBe("number");
  });
});
```

`DIALECTS` is `["sqlite", "postgres"]` when `CANVAS_DROP_DB` is unset and collapses to that one dialect when it is set. The `test:sqlite` / `test:pg` scripts set it, so the CI legs are genuinely split.

### Harnesses above the DB layer

| Need | Use |
|------|-----|
| Typed config without touching `process.env` | `loadConfig({ CANVAS_DROP_AUTH_MODE: "dev", ... })` from `@canvas-drop/shared`; it validates the overrides exactly as boot does |
| A storage driver | `memStorage()` from `apps/server/src/storage/mem.ts` |
| A route under test as a chosen user | mount the route module on a `Hono<AppEnv>` app with a stub identity middleware; `apps/server/src/routes/management.test.ts` is the pattern |
| The real composed app (gateway, identity, access, primitives, audit, MCP) | `makeHarness(client)` in `apps/server/src/integration/scenario-harness.ts`: `GET` / `SEND` act as an email, `listen()` boots a real socket for realtime, `connectMcp(h, caller)` binds an in-process MCP client to the same DB and storage |
| A deterministic AI provider | `fakeProvider(...)` from `apps/server/src/ai/testing.ts` |
| Invites without email delivery | `makeInviteService(client, config)` from `apps/server/src/invites/testing.ts`; the scenario harness's `captureMailer()` records outgoing messages |
| Seeded users and canvases | `seedUser`, `seedPublishedCanvas`, `seedListed` in `apps/server/src/db/repositories/gallery-test-helpers.ts` |

The scenario suites (`apps/server/src/integration/*-scenarios.test.ts`) run the acceptance stories in `docs/qa/2026-06-20-capability-scenarios.md` against the real app. When an in-process `app.request()` test seems to return the wrong `.status`, assert on the body or drive the request over `listen()` + `fetch`; see `docs/solutions/2026-06-21-tenancy-inert-active-and-test-harness-gotchas.md`.

### Drift guards that fail the build

- **Schema parity** (`packages/shared/src/db/schema.test.ts`): diffs every table across `schema.pg.ts` and `schema.sqlite.ts` by column name, `notNull`, primary key, indexes (name, uniqueness, columns), foreign keys, and CHECK constraint names, and asserts the `role` columns default to `viewer` on both. The 29 tables are keyed by name in the test's `pgTables` / `sqliteTables` maps, so a new table must be added to both maps to be covered.
- **Populated-DB migration** (`apps/server/src/db/migrate-populated.test.ts`): builds a real, populated SQLite database at a pre-`0011` and a pre-`0036` schema and migrates it through the factory path, because the normal harness only ever migrates empty databases and cannot see a `DROP TABLE` that violates foreign keys on live rows.
- **MCP inventory equals the role table** (`apps/server/src/mcp/server.test.ts`): every registered MCP tool needs an entry in `TOOL_MIN_ROLE` (`apps/server/src/mcp/tool-roles.ts`) and vice versa. A role matrix then runs every canvas-scoped tool as owner, editor, viewer, and no-role on both dialects: viewer and no-role read `not found`, an editor calling an `owner` tool reads `OWNER_ONLY: ...`, everything else is admitted. Register a tool without a table entry and the suite fails.

## Parallel-agent test hygiene

`scripts/test-runner.mjs` exists because several agents can run tests from separate worktrees at the same time. What it does:

- **Registers each run** as a JSON file under `/tmp/canvas-drop-test-runs` (`%TEMP%\canvas-drop-test-runs` on Windows; override with `CANVAS_DROP_TEST_REGISTRY_DIR`). On startup it reaps only the process groups of stale registered runs whose launcher is gone, and only after confirming the child still carries the run's injected `CANVAS_DROP_TEST_CHILD_MARKER`, so a recycled pid is never killed. Do not use `pkill -f vitest` or other broad pattern kills; they can hit another live agent.
- **Waits for a local slot** before each phase: if a genuine `node ... vitest` process is already touching this worktree, the runner waits (logging every 5 s) for up to 10 minutes, then aborts with the blocking pids. Shells that merely mention `vitest`, and sibling launchers that have not spawned Vitest yet, do not count. One agent should have at most one test worker pool active in a worktree.
- **Budgets workers**: a solo run gets one worker per core; concurrent registered runs split the cores evenly, never below one. Override with `CANVAS_DROP_TEST_MAX_WORKERS=4 pnpm test` (an integer or a percentage such as `25%`) when you need headroom. A bare `pnpm test:watch` bypasses the runner and defaults to `100%`; throttle it with `--maxWorkers`.
- **Namespaces per run**: sets `CANVAS_DROP_TEST_RUN_ID`, which scopes the Vite cache directories (`node_modules/.vite/vitest-<run>-root` and `apps/dashboard/node_modules/.vite/vitest-<run>-dashboard`) and the real-infra smoke-test resources. It removes its own cache directories on exit and clears those of stale runs on the next start.
- **Single-file mode** (`pnpm test:file`) runs with `--pool=forks --maxWorkers=1 --no-file-parallelism` and prints a heartbeat every 15 s while the file is still running. Prefer it in the foreground for tight iteration. Avoid piping a long run through `tail` and walking away: if the launcher is killed, its workers can keep running until the next supervised run reaps them.

When a whole class of dashboard or router tests times out, first run one untouched, cheap, pure test such as `pnpm test:file apps/dashboard/src/test/format.test.tsx`. A fast pass points at shared setup or provider code in the failing area; a slow or silent run points at process contention. jsdom stubs for `scrollTo`, `matchMedia`, `ResizeObserver`, and `IntersectionObserver` live in `apps/dashboard/src/test/setup.ts`, which also raises Testing Library's `asyncUtilTimeout` to 5 s and unmounts trees between tests; add new browser APIs there before blaming the environment.

## Opt-in tests against real infrastructure

`apps/server/src/integration/real-infra.test.ts` exercises the **production drivers** the in-process stand-ins cannot: `node-postgres` against a real Postgres server, and the real `S3Driver` against MinIO. Both suites are `describe.skipIf` on env, so they run in CI and for anyone who opts in, and never block a local `pnpm test`:

| Env | Enables |
|-----|---------|
| `CANVAS_DROP_TEST_DATABASE_URL` | the real-Postgres smoke test; it creates a per-run database (`<name>_<run id>`) from the URL's database name and drops it afterwards |
| `CANVAS_DROP_TEST_S3_ENDPOINT` (+ `_BUCKET`, `_REGION`, `_ACCESS_KEY`, `_SECRET_KEY`; defaults `canvas-drop-test`, `us-east-1`, `minioadmin` / `minioadmin`) | the MinIO smoke test; it writes under a per-run `smoke/<run id>/` key prefix and deletes the object |

Both derive the run id from the runner's `CANVAS_DROP_TEST_RUN_ID`, so overlapping agent runs never share databases or object keys.

`apps/server/src/screenshots/capture.integration.test.ts` drives real headless Chromium through the capture engine. It is skipped everywhere, including CI, unless you opt in on a machine with Playwright's Chromium installed:

```
CANVAS_DROP_TEST_SCREENSHOTS=1 pnpm test:file apps/server/src/screenshots/capture.integration.test.ts
```

Screenshot capture for the docs site (`pnpm docs:screenshots`) is a manual script against a running dev dashboard, not a test, and does not run in CI.

## CI matrix (`.github/workflows/ci.yml`)

Runs on every push to `main` and every pull request, on Node 24 with `pnpm@11.0.9`.

| Job | What it proves |
|-----|----------------|
| `lint` (Lint & typecheck) | `pnpm lint` (Biome) and `pnpm typecheck`; also re-runs `pnpm docs:build` and `pnpm docs:mermaid` and fails on any diff in `apps/server/src/docs/generated-content.ts` or `docs/site/assets/mermaid.js` |
| `test-sqlite` (Test (sqlite)) | `pnpm test:sqlite`: root suite on the SQLite dialect only |
| `test-dashboard` (Test (dashboard)) | `pnpm test:dashboard`: the jsdom suite, run once because it is dialect-agnostic |
| `test-postgres` (Test (postgres + real infra)) | `pnpm test:pg`: root suite on pglite, plus the real `postgres:16` service and a MinIO container (started as a step, with the bucket created up front) with the `CANVAS_DROP_TEST_*` env set |
| `build` (Build) | `pnpm build` (`pnpm -r build`: shared, sdk, dashboard, server) |
| `dependency-audit` (Dependency audit (advisory)) | `pnpm audit --audit-level high \|\| true`; logs findings, never fails the run |

A change that passes on SQLite but breaks Postgres fails `test-postgres`. CI is the explicit, authoritative gate, and server-side branch protection on `main` is enabled: the CI matrix is a required status check, so every change lands through a green PR, never a direct push. A separate `Security` workflow (`.github/workflows/security.yml`) runs a blocking gitleaks scan of the working tree on the same triggers, then plants a fake token outside the allowlist and asserts the scan still catches it.

## Read next

- `docs/solutions/2026-06-13-ci-and-test-infra-gotchas.md`: pglite instead of a server, MinIO as a step rather than a service container, cwd-relative migration folders, making the dialect split real, and why the PGlite instance is reused per worker.
- `docs/solutions/2026-06-14-parallel-agent-worktree-isolation.md`: running tests from several worktrees at once.
- `docs/solutions/2026-06-21-tenancy-inert-active-and-test-harness-gotchas.md`: the `app.request()` stale-status trap and the harness's default identity.
