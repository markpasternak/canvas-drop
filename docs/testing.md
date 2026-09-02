# Testing

Gate yourself before you push. There is no local pre-push hook; the CI matrix on the PR is the authoritative gate, and server-side branch protection on `main` requires it.

```
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` runs the root suite on **both** database dialects in one process, then the dashboard suite. CI re-runs the same matrix in a clean environment; that green is what authorizes a merge. Requires Node `>=24` and `pnpm@11.0.9` (pinned in `package.json`; `corepack enable` picks it up).

## Commands

```
pnpm test                                        # full suite: root (both dialects), then dashboard
pnpm test:sqlite                                 # root suite, CANVAS_DROP_DB=sqlite only
pnpm test:pg                                     # root suite, CANVAS_DROP_DB=postgres only
pnpm test:dashboard                              # dashboard/jsdom suite only
pnpm test:file apps/server/src/db/db.test.ts     # one file, single worker, verbose
pnpm test:watch                                  # bare `vitest` watch mode, root config
```

Everything except `test:watch` goes through `scripts/test-runner.mjs` (see "Parallel-agent test hygiene"). `test:file` accepts several paths and extra Vitest flags; a leading `--` is stripped, so `pnpm test:file -- <path>` works too. It picks the dashboard config automatically when the path is under `apps/dashboard/`.

Where tests live and which config runs them:

| Suite | Config | Picks up | Environment |
|-------|--------|----------|-------------|
| root | `vitest.config.ts` | `{apps,packages}/*/src/**/*.test.ts`, `scripts/*.test.mjs` | `node`; `testTimeout` and `hookTimeout` 20 s |
| dashboard | `apps/dashboard/vitest.config.ts` | `apps/dashboard/src/**/*.test.tsx` | `jsdom`, `src/test/setup.ts` |

A server test must end in `.test.ts`; a dashboard test must end in `.test.tsx`.

## Dual-dialect is the point

canvas-drop runs on **SQLite or Postgres** from one schema (BUILD_BRIEF.md §10, Risk #2). Every DB test runs against both on a bare `pnpm test`:

- **SQLite**: `better-sqlite3`, a fresh in-memory database per `makeTestDb` call, `foreign_keys = ON`.
- **Postgres**: `pglite`, the real PostgreSQL engine compiled to WASM, in-process. No server needed. One migrated instance is shared per Vitest worker and every table is truncated on each `makeTestDb` acquire, so a test starts clean whether or not the previous one called `close()`. Use `makeFreshPgTestDb()` only when a test must observe a clean migration apply.

Both run the **actual generated migrations** from `drizzle/sqlite` and `drizzle/pg`, so a migration that breaks on one dialect fails the suite immediately. It also means a schema-only change never reaches the test DB: after editing `schema.pg.ts` / `schema.sqlite.ts`, generate a migration for both dialects and commit `drizzle/pg/*` and `drizzle/sqlite/*`:

```
npx drizzle-kit generate --config=drizzle.pg.config.ts --name=<slug>
npx drizzle-kit generate --config=drizzle.sqlite.config.ts --name=<slug>
```

### Writing a dual-dialect test

Parameterize with `DIALECTS` and build the DB inside the test body (from `apps/server/src/db/db.test.ts`):

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
      email: "someone@example.com",
      name: "A",
      isAdmin: false,
    });
    expect(typeof u.createdAt).toBe("number");
  });
});
```

`DIALECTS` (`apps/server/src/db/testing.ts`) is `["sqlite", "postgres"]` when `CANVAS_DROP_DB` is unset and collapses to that one dialect when it is set. The `test:sqlite` / `test:pg` scripts set it, so the CI legs are genuinely split.

### Drift guards that fail the build

- **Schema parity** (`packages/shared/src/db/schema.test.ts`): diffs every table across `schema.pg.ts` and `schema.sqlite.ts` by column name, `notNull`, primary key, indexes (name, uniqueness, columns), foreign keys, and CHECK constraint names. A change made on one dialect only fails here.
- **Populated-DB migration** (`apps/server/src/db/migrate-populated.test.ts`): migrates a real, populated pre-0011 SQLite database through the factory path, because the normal harness only ever migrates empty databases.
- **MCP inventory equals the role table** (`apps/server/src/mcp/server.test.ts`): every registered MCP tool needs an entry in `apps/server/src/mcp/tool-roles.ts` and vice versa, and owner / editor / viewer / no-role callers get exactly the table's outcome for every canvas-scoped tool.

## Parallel-agent test hygiene

`scripts/test-runner.mjs` exists because several agents can run tests from separate worktrees at the same time. What it does:

- **Registers each run** as a JSON file under `/tmp/canvas-drop-test-runs` (`%TEMP%\canvas-drop-test-runs` on Windows; override with `CANVAS_DROP_TEST_REGISTRY_DIR`). On startup it reaps only the process groups of stale registered runs whose launcher is gone, and only after confirming the child still carries the run's injected `CANVAS_DROP_TEST_CHILD_MARKER`, so a recycled pid is never killed. Do not use `pkill -f vitest` or other broad pattern kills; they can hit another live agent.
- **Waits for a local slot** before each phase: if a genuine `node … vitest` process is already touching this worktree, the runner waits (logging every 5 s) for up to 10 minutes, then aborts with the blocking pids. One agent should have at most one test worker pool active in a worktree.
- **Budgets workers**: a solo run gets one worker per core; concurrent registered runs split the cores evenly, never below one. Override with `CANVAS_DROP_TEST_MAX_WORKERS=4 pnpm test` (an integer or a percentage such as `25%`) when you need headroom. A bare `pnpm test:watch` bypasses the runner and defaults to `100%`; throttle it with `--maxWorkers`.
- **Namespaces per run**: sets `CANVAS_DROP_TEST_RUN_ID`, which scopes the Vite cache directories (`node_modules/.vite/vitest-<run>-root` and `-dashboard`) and the real-infra smoke-test resources. It removes its own cache directories on exit and clears those of stale runs on the next start.
- **Single-file mode** (`pnpm test:file`) runs with `--pool=forks --maxWorkers=1 --no-file-parallelism --reporter=verbose` and prints a heartbeat every 15 s while the file is still running. Prefer it in the foreground for tight iteration. Avoid piping a long run through `tail` and walking away: if the launcher is killed, its workers can keep running until the next supervised run reaps them.

When a whole class of dashboard or router tests times out, first run one untouched, cheap, pure test such as `pnpm test:file apps/dashboard/src/test/format.test.tsx`. A fast pass points at shared setup or provider code in the failing area; a slow or silent run points at process contention. jsdom stubs for `scrollTo`, `matchMedia`, `ResizeObserver`, and `IntersectionObserver` live in `apps/dashboard/src/test/setup.ts`; add new browser APIs there before blaming the environment.

## Opt-in tests against real infrastructure

`apps/server/src/integration/real-infra.test.ts` exercises the **production drivers** the in-process stand-ins cannot: `node-postgres` against a real Postgres server, and the real `S3Driver` against MinIO. Both suites are `describe.skipIf` on env, so they run in CI and for anyone who opts in, and never block a local `pnpm test`:

| Env | Enables |
|-----|---------|
| `CANVAS_DROP_TEST_DATABASE_URL` | the real-Postgres smoke test; it creates a per-run database (`<name>_<run id>`) and drops it afterwards |
| `CANVAS_DROP_TEST_S3_ENDPOINT` (+ `_BUCKET`, `_REGION`, `_ACCESS_KEY`, `_SECRET_KEY`; MinIO defaults if unset) | the MinIO smoke test; it writes under a per-run `smoke/<run id>/` key prefix |

Both derive the run id from the runner's `CANVAS_DROP_TEST_RUN_ID`, so overlapping agent runs never share tables or object keys.

`apps/server/src/screenshots/capture.integration.test.ts` drives real headless Chromium through the capture engine. It is skipped everywhere, including CI, unless you opt in on a machine with Playwright's Chromium installed:

```
CANVAS_DROP_TEST_SCREENSHOTS=1 pnpm exec vitest run apps/server/src/screenshots/capture.integration.test.ts
```

Screenshot capture for the docs site (`pnpm docs:screenshots`) is a manual script against a running dev dashboard, not a test, and does not run in CI.

## CI matrix (`.github/workflows/ci.yml`)

Runs on every push to `main` and every pull request, on Node 24 with `pnpm@11.0.9`.

| Job | What it proves |
|-----|----------------|
| `lint` (Lint & typecheck) | `pnpm lint` (Biome) and `pnpm typecheck`; also re-runs `pnpm docs:build` and `pnpm docs:mermaid` and fails on any diff in `apps/server/src/docs/generated-content.ts` or `docs/site/assets/mermaid.js` |
| `test-sqlite` (Test (sqlite)) | `pnpm test:sqlite`: root suite on the SQLite dialect only |
| `test-dashboard` (Test (dashboard)) | `pnpm test:dashboard`: the jsdom suite, run once because it is dialect-agnostic |
| `test-postgres` (Test (postgres + real infra)) | `pnpm test:pg`: root suite on pglite, plus the real `postgres:16` service and a MinIO container with the `CANVAS_DROP_TEST_*` env set |
| `build` (Build) | `pnpm build` (`pnpm -r build`: shared, sdk, dashboard, server) |
| `dependency-audit` (Dependency audit (advisory)) | `pnpm audit --audit-level high \|\| true`; logs findings, never fails the run |

A change that passes on SQLite but breaks Postgres fails `test-postgres`. A separate `Security` workflow (`.github/workflows/security.yml`) runs a blocking gitleaks scan of the working tree on the same triggers.

Gotchas that have bitten before (pglite vs. a server, MinIO as a step rather than a service container, cwd-relative migration folders, the dialect split) are collected in `docs/solutions/2026-06-13-ci-and-test-infra-gotchas.md`.
