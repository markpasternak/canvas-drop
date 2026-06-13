---
title: Dual-dialect Drizzle — per-dialect schemas, a typed `any` repo seam, and pglite for the PG test leg
type: architecture
area: data
date: 2026-06-13
---

## The constraint

Drizzle generates **dialect-specific clients at compile time**. `pgTable(...)` and
`sqliteTable(...)` are distinct builders producing distinct types — there is no single
schema object or single `db` type that serves both. The brief's "one Drizzle schema"
(§10) is a *logical* goal, not something Drizzle gives you literally.

## How we resolved it (KTD-1)

1. **Two schema files, one shape.** `schema.pg.ts` and `schema.sqlite.ts` are built from
   shared column helpers in `columns.ts` (`pg.*` / `sqlite.*`). Same columns, same
   constraints, different builders.
2. **Shared inferred row types.** `types.ts` derives `User`, `Session`, … from the PG
   schema; the app codes against *these*, never a raw dialect table.
3. **A documented `any` seam in each repository.** A repository does
   `const db = client.db as any` and picks `client.dialect === "sqlite" ? sqliteSchema.x : pgSchema.x`.
   This is the *only* place the dialect split leaks. Inputs and return types stay fully
   typed (`User`, `Session`); the cast is just to let one statement run against either
   builder. Don't try to make this generic — it fights Drizzle's type system and the
   parity test already guarantees the shapes match.
4. **Parity is test-enforced.** `schema.test.ts` diffs the two schemas column-by-column
   (name, notNull, primary). If someone adds a column to one dialect and not the other,
   the build fails — not a runtime surprise.

## Testing both dialects without Docker

Use **`@electric-sql/pglite`** for the Postgres test leg: it's the real PostgreSQL
engine compiled to WASM, in-process, with perfect per-test isolation (`new PGlite()`).
It runs the **real generated `drizzle/pg` migrations**, so it catches dialect drift as
well as a server would. `makeTestDb(dialect)` in `apps/server/src/db/testing.ts` returns
sqlite (better-sqlite3 `:memory:`) or postgres (pglite); every dialect-parameterized
suite uses `describe.each(DIALECTS)`.

The **production** drivers (`node-postgres`, real S3) are covered separately by
`integration/real-infra.test.ts`, gated on `CANVAS_DROP_TEST_*` env so it only runs in
CI against the `postgres:16` + MinIO services. pglite proves the SQL; the smoke test
proves the wire driver.

## Gotcha: migration folder resolution

The migrator's `migrationsFolder` is **cwd-relative**. Tests run from the repo root so
`drizzle/sqlite` resolves; `pnpm dev` runs from `apps/server` (via `--filter`) and it
does not. `resolveMigrationsDir()` walks up from cwd to find `drizzle/<dialect>` — works
from root, the package dir, and a built image. See [[agent-workflow]] for the unit order.

## What a code review added to this seam (2026-06-13 review round)

- **`onConflictDoUpdate` works on both dialects** — use it for atomic upsert instead
  of read-then-write (which races into a unique-constraint 500 under concurrency).
  Exclude immutable/security columns (`created_at`, `is_blocked`) from the update set.
- **Put the dialect branch behind a method on `DbClient`, not in callers.** The health
  check originally branched `client.dialect` + `as any` to pick `.run()` (sqlite) vs
  `.execute()` (pg). That's the seam leaking out of `db/`. Adding `ping()` to the
  `DbClient` interface (implemented per-dialect in the factory) closed it — callers get
  zero-any, zero-branch. Apply the same move for any future cross-dialect primitive.
- **The parity test must check indexes/uniqueness/FKs, not just columns.**
  `getTableColumns` misses them; `getTableConfig` (from `drizzle-orm/pg-core` and
  `drizzle-orm/sqlite-core`) exposes the index + FK arrays. `sessions_token_hash_uq`
  underpins `findLiveByToken`'s security contract — a uniqueIndex dropped on one dialect
  would otherwise drift silently. See [[auth-invariant-checklist]] and
  [[ci-and-test-infra-gotchas]].
