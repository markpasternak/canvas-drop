# Testing

Before you push, gate yourself — there is no local pre-push hook:

```
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` runs the full suite on **both** database dialects in one go, then the dashboard suite. CI re-runs the same matrix in a clean environment, and that green is what authorizes a merge.

## Dual-dialect is the point

canvas-drop runs on **SQLite or Postgres** from one schema (BUILD_BRIEF.md §10, Risk #2). The test suite proves both on every run:

- **SQLite** — `better-sqlite3`, in-memory.
- **Postgres** — `pglite`, the real PostgreSQL engine compiled to WASM, in-process. It runs the **actual generated `drizzle/pg` migrations** and real Postgres SQL, so dialect drift fails the build immediately. No server needed.

Dialect-parameterized suites use `describe.each(DIALECTS)` (`apps/server/src/db/testing.ts`). The schema-parity test (`packages/shared/src/db/schema.test.ts`) additionally diffs the two dialect schemas column-by-column — column names, `notNull`, primary keys, indexes, and foreign keys — so a `schema.pg.ts` / `schema.sqlite.ts` divergence fails the build.

## Commands

```
pnpm test          # supervised full suite: root node tests, then dashboard
pnpm test:sqlite   # supervised root suite with CANVAS_DROP_DB=sqlite
pnpm test:pg       # supervised root suite with CANVAS_DROP_DB=postgres
pnpm test:dashboard # supervised dashboard/jsdom suite
pnpm test:file -- apps/server/src/db/db.test.ts # low-worker single-file iteration
pnpm test:watch    # direct Vitest watch mode
```

The root suite defaults to both dialects when `CANVAS_DROP_DB` is unset. The
`:sqlite` / `:pg` scripts set it so CI matrix legs are genuinely split.

## Parallel-agent test hygiene

The non-watch test scripts go through `scripts/test-runner.mjs` instead of invoking
Vitest directly. The runner exists because several agents can run tests from
separate worktrees at the same time:

- It registers active runs under the system temp directory (`canvas-drop-test-runs`)
  and reaps only process groups from stale registered runs whose launcher PID is
  gone. Do not use `pkill -f vitest` or broad command-pattern kills; those can hit
  another live agent.
- Before launching a Vitest phase, it waits for existing Vitest/test-runner
  processes that are already touching this worktree. One agent should have at most
  one test worker pool active in a worktree.
- It shares roughly half the machine's available workers across active registered
  test runs. Override intentionally with `CANVAS_DROP_TEST_MAX_WORKERS=8 pnpm test`
  (or a percentage such as `25%`) when running solo on a machine with headroom.
- It sets `CANVAS_DROP_TEST_RUN_ID` so Vitest/Vite caches and real-infra smoke-test
  resources are namespaced per run. The runner removes those run-scoped Vite cache
  directories when it exits, and on the next supervised startup it also clears
  caches from stale registered runs.
- For tight iteration, prefer `pnpm test:file -- <test-file>` in the foreground.
  This uses a single fork, no file parallelism, verbose reporting, and a heartbeat
  when the file is still running. Avoid piping long test runs through `tail` and
  walking away; if a launcher is killed, workers can otherwise continue until the
  next supervised run reaps them.

When a whole class of dashboard/router tests times out, first run one untouched
cheap pure test such as `pnpm test:file -- apps/dashboard/src/test/format.test.tsx`.
A fast pass points at shared setup/provider code in the failing area; a slow or
silent run points at process contention. Add jsdom stubs for new browser APIs
(`matchMedia`, `ResizeObserver`, `IntersectionObserver`) in
`apps/dashboard/src/test/setup.ts` before blaming the environment.

## Real-infrastructure smoke tests

`apps/server/src/integration/real-infra.test.ts` exercises the **production drivers** that the in-process stand-ins can't:

- `node-postgres` against a real Postgres server,
- the real `S3Driver` against MinIO.

They are **skipped unless** the corresponding env is set, so they run in CI (and for operators who opt in) but never block local `pnpm test`:

- `CANVAS_DROP_TEST_DATABASE_URL` — enables the real-Postgres smoke test.
- `CANVAS_DROP_TEST_S3_ENDPOINT` (+ `_BUCKET` / `_REGION` / `_ACCESS_KEY` / `_SECRET_KEY`) — enables the MinIO smoke test.

When enabled, the smoke tests use the runner's `CANVAS_DROP_TEST_RUN_ID` to create a
temporary Postgres database and S3 key prefix per run, then clean them up. This keeps
overlapping agent runs from sharing tables or object keys.

## CI matrix (`.github/workflows/ci.yml`)

| Job | What it proves |
|-----|----------------|
| `lint` (Lint & typecheck) | `pnpm lint` (Biome) + `pnpm typecheck`, and asserts `apps/server/src/docs/generated-content.ts` is regenerated (`pnpm docs:build` then `git diff --exit-code`) |
| `test-sqlite` | root suite on the SQLite dialect only (`CANVAS_DROP_DB=sqlite`) — Postgres-dialect coverage comes from `test-postgres` |
| `test-dashboard` | dashboard/jsdom suite |
| `test-postgres` | root suite on PGlite/Postgres **plus** real `postgres:16` + MinIO smoke tests |
| `build` | every workspace package builds (`pnpm build` → `pnpm -r build`: shared, sdk, dashboard, server) |
| `dependency-audit` | advisory `pnpm audit --audit-level high` (non-blocking — logs findings, never fails the run) |

A change that passes on SQLite but breaks Postgres fails `test-postgres`. CI is the explicit, authoritative gate; server-side branch protection on `main` arrives when the repo goes public or on Pro.
