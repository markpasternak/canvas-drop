---
title: CI + test-infra gotchas — pglite, MinIO-in-Actions, native module build approval
type: workflow
area: ops
date: 2026-06-13
---

Setting up the dual-dialect CI matrix and local test infra surfaced several
non-obvious snags. See also [[dual-dialect-drizzle-seam]].

## pnpm blocks native build scripts by default

`better-sqlite3` and `esbuild` (via vitest/drizzle-kit) have postinstall build
steps that **pnpm 11 ignores unless approved**. Symptom: `ERR_PNPM_IGNORED_BUILDS`,
then a missing native binary at runtime. Fix: add them under `allowBuilds:` in
`pnpm-workspace.yaml` (e.g. `better-sqlite3: true`, `esbuild: true`) and reinstall.
This is committed, so it only bites once.

## Test the Postgres dialect with pglite, not a server

`@electric-sql/pglite` is real PostgreSQL (WASM, in-process). `makeTestDb('postgres')`
spins one up per test with the real `drizzle/pg` migrations — full dialect-drift
coverage, no Docker, runs everywhere including a daemon-less laptop. Reserve a real
`postgres:16` service + the `node-postgres` wire driver for the CI smoke test only
(`integration/real-infra.test.ts`, env-gated on `CANVAS_DROP_TEST_*`).

## GitHub Actions: MinIO can't be a service container

Two traps, both cost a red CI run:
- **`bitnami/minio:latest` was removed from Docker Hub** (Bitnami deprecated
  `latest` tags). Use the official `minio/minio`.
- **`minio/minio` needs a `server /data` command**, and Actions **service
  containers cannot override the image command**. So run MinIO as a normal
  **step** (`docker run -d … minio/minio server /data`), health-poll it, and
  create the bucket with the preinstalled AWS CLI. Postgres stays a service
  container (it needs no command).
- **Don't use a conditional `image: ${{ … && 'x' || '' }}` on a service** —
  an empty image string fails init. Split into separate jobs instead
  (`test-sqlite` with no services, `test-postgres` with them).

## Migration folder resolution is cwd-relative

Drizzle's `migrationsFolder` resolves against `process.cwd()`. Tests run from the
repo root (works); `pnpm dev` runs from `apps/server` via `--filter` (breaks).
`resolveMigrationsDir()` walks up from cwd to find `drizzle/<dialect>` so it works
from root, the package dir, or a built image.

## Make the dialect split real

`pnpm test` runs both dialects in-process via `describe.each(DIALECTS)`. The
`test:sqlite` / `test:pg` scripts set `CANVAS_DROP_DB`, but `DIALECTS` must
actually *read* it (`envDialect ? [envDialect] : ['sqlite','postgres']`) or both
CI legs run identical sets and the script names lie.

## Biome: `format` ≠ `organizeImports`

`biome format --write` does not sort imports; `biome check --write` does. CI runs
`biome check` (which flags unsorted imports as errors), so the repo's `format`
script is aliased to `biome check --write` — otherwise `pnpm format` leaves
import-order errors that fail `pnpm lint`.

## Reuse the PGlite test DB — don't boot one per test

`makeTestDb("postgres")` originally did `new PGlite()` + replay all migrations
**inside every `it()`**. WASM boot + migration replay is a flat ~1.4s, so the
`test:pg` leg paid it ~hundreds of times: the leg's `tests` time was 176s and the
CI job ~4m29s, while the sqlite leg ran the same suite in ~45s (in-memory
better-sqlite3 boot is near-free). The slowness was per-test fixed setup, not
slow queries — the tell was every DB test costing an identical ~1.4s regardless
of assertions.

Fix (in `apps/server/src/db/testing.ts`): keep **one migrated PGlite per worker**
and reset it between tests instead of rebuilding. Vitest isolates by file, so this
amortises boot+migrate to once per *file*. Dropped `tests` 176s → ~37s.

Gotchas that make the reuse correct:
- **Reset on acquire, not on close.** `makeTestDb` truncates before handing the
  client back, so a test starts clean even if its suite forgets `close()`. `close()`
  is a no-op for the shared instance (torn down with the worker).
- **`TRUNCATE … RESTART IDENTITY CASCADE` over `public` tables only.** Drizzle's
  migration journal lives in the `drizzle` schema, so a public-only truncate leaves
  it intact and a repeat `migrate()` stays a no-op (the idempotency contract).
- **Keep a `makeFreshPgTestDb()` escape hatch.** The "applies migrations cleanly"
  test needs a virgin DB — against the shared (already-migrated) instance, `migrate()`
  would just no-op and the clean-apply assertion would be hollow.
- SQLite stays fresh-per-call: in-memory boot is already free, so no reason to add
  shared-state risk there.

## Branch protection on a private repo needs Pro

GitHub gates both classic branch protection AND rulesets behind Pro for **private**
repos (HTTP 403 "Upgrade to GitHub Pro or make this repository public"). Interim
stand-in: a committed `.githooks/pre-push` that runs lint+typecheck+test before a
push to `main`; enable per clone with `git config core.hooksPath .githooks`.
Real server-side protection arrives when the repo goes public (BUILD_BRIEF OPEN-8)
or on a Pro plan.
