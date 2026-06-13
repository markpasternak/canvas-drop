# Testing

## Dual-dialect is the point

canvas-drop runs on **SQLite or Postgres** from one schema (BUILD_BRIEF.md §10, Risk #2). The test suite proves both on every run:

- **SQLite** — `better-sqlite3`, in-memory.
- **Postgres** — `pglite`, the real PostgreSQL engine compiled to WASM, in-process. It runs the **actual generated `drizzle/pg` migrations** and real Postgres SQL, so dialect drift fails the build immediately. No server needed.

Dialect-parameterized suites use `describe.each(DIALECTS)` (`apps/server/src/db/testing.ts`). The schema-parity test (`packages/shared/src/db/schema.test.ts`) additionally diffs the two dialect schemas column-by-column.

## Commands

```
pnpm test          # full suite (runs both dialects in-process)
pnpm test:sqlite   # CANVAS_DROP_DB=sqlite path
pnpm test:pg       # CANVAS_DROP_DB=postgres path
pnpm test:watch    # watch mode
```

The `:sqlite` / `:pg` scripts mainly exercise the script paths used by the CI matrix legs; the suite itself always covers both dialects regardless of `CANVAS_DROP_DB`.

## Real-infrastructure smoke tests

`apps/server/src/integration/real-infra.test.ts` exercises the **production drivers** that the in-process stand-ins can't:

- `node-postgres` against a real Postgres server,
- the real `S3Driver` against MinIO.

They are **skipped unless** the corresponding env is set, so they run in CI (and for operators who opt in) but never block local `pnpm test`:

- `CANVAS_DROP_TEST_DATABASE_URL` — enables the real-Postgres smoke test.
- `CANVAS_DROP_TEST_S3_ENDPOINT` (+ `_BUCKET` / `_REGION` / `_ACCESS_KEY` / `_SECRET_KEY`) — enables the MinIO smoke test.

## CI matrix (`.github/workflows/ci.yml`)

| Job | What it proves |
|-----|----------------|
| `lint` | Biome + `tsc --noEmit` |
| `test-sqlite` | full suite (sqlite + pglite in-process) |
| `test-postgres` | full suite **plus** real `postgres:16` + MinIO smoke tests |
| `build` | the server compiles (`tsc`) |
| `dependency-audit` | advisory `pnpm audit` (non-blocking) |

A change that passes on SQLite but breaks Postgres fails `test-postgres`. After this lands, enable branch protection on `main` requiring these checks.
