---
title: Catching a unique-constraint violation across dialects (the pglite `.cause` nesting)
type: gotcha
area: data
date: 2026-06-17
---

## What this is

The custom-slug round (plan `2026-06-16-004`) needed to turn a slug collision into a
clean `409`, which meant **catching a DB unique-constraint throw and mapping it** —
something the codebase had never done before (every prior dedup used
`onConflictDoUpdate`). Doing that portably across our three drivers is the gotcha.
See also [[dual-dialect-drizzle-seam]].

## The trap

The error shape differs by driver, and one of them nests:

- **better-sqlite3** (prod + sqlite test leg): throws a `SqliteError` directly —
  `err.code === "SQLITE_CONSTRAINT_UNIQUE"`, and the message names the **column**
  (`"UNIQUE constraint failed: canvases.slug"`), **not** the index.
- **node-postgres** (prod PG option): throws a `DatabaseError` with
  `err.code === "23505"` and `err.constraint === "canvases_slug_uq"` (the **index**).
- **pglite** (the Postgres *test* leg): Drizzle **wraps** the real `DatabaseError`
  one level down under **`err.cause`** — the outer error has `code: undefined`. So a
  check that only inspects the top-level `err.code`/`err.constraint` silently returns
  `false` on the pg test leg and the `409` mapping never fires.

A naïve `catch → 409` also mis-maps the table's *other* unique index
(`canvases_api_key_hash_uq`) to `slug_taken`. The match must be target-specific.

## The fix (what to copy)

`apps/server/src/db/unique-violation.ts` — `isUniqueViolation(err, target)` where
`target = { pgConstraint, sqliteColumn }`:

- SQLite branch: `code === "SQLITE_CONSTRAINT_UNIQUE"` **AND** the message contains the
  `table.column` token.
- Postgres branch: `code === "23505"` **AND** (`constraint === pgConstraint` **OR** the
  message contains the index name).
- **Inspect `err` AND `err.cause`** — the drizzle wrapper puts the pglite/PG
  `DatabaseError` under `.cause`.

`SLUG_UNIQUE = { pgConstraint: "canvases_slug_uq", sqliteColumn: "canvases.slug" }`.

## Lessons that generalize

- **Test the catch on BOTH legs, not just sqlite.** A synthesized-error unit test
  passes trivially; the real divergence (the `.cause` nesting) only shows when the
  actual driver throws. The route-level `409` test runs `it.each(DIALECTS)` so the pg
  leg exercises the real pglite error
  (`apps/server/src/routes/management.test.ts`).
- **Uniqueness checks must agree with the actual index.** `canvases_slug_uq` is
  unconditional (includes soft-deleted rows), but `findBySlug` excludes `deleted`. The
  availability check and the random-slug generator's existence probe must use a
  **status-unaware** lookup (`canvases.slugTaken`) or they disagree with the index — a
  green "available" that then `409`s, or a generated random slug colliding with a
  tombstone and throwing uncaught. (KTD8 in the plan.)
- The unique index is the **authority**; the pre-check is advisory. The catch closes
  the check-then-act race — don't try to close it with a lock.

Read this before adding any other "catch a constraint violation and map it" path.
