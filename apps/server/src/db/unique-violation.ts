/**
 * Dialect-aware unique-constraint detection (plan 004, KTD7).
 *
 * There is no shared "catch the constraint throw" pattern elsewhere — every other
 * dedup path uses `onConflictDoUpdate`. Custom slugs need a real catch so a taken
 * slug becomes a clean `409`, and the error shape differs by driver:
 *
 *   - better-sqlite3 → `err.code === "SQLITE_CONSTRAINT_UNIQUE"`, and the message
 *     names the COLUMN ("UNIQUE constraint failed: canvases.slug").
 *   - node-postgres / pglite → `err.code === "23505"`, and the message and/or
 *     `err.constraint` names the INDEX ("…unique constraint \"canvases_slug_uq\"").
 *
 * Drizzle wraps the driver error: better-sqlite3's `SqliteError` surfaces directly,
 * but the postgres/pglite `DatabaseError` is nested one level under `.cause` (the
 * outer error has `code: undefined`). So we inspect the error AND its `.cause`.
 *
 * Matching on the specific target keeps an unrelated unique index on the same
 * table (e.g. `canvases_api_key_hash_uq`) from being mis-mapped to `slug_taken`.
 */
export interface UniqueTarget {
  /** Postgres index/constraint name, as it appears in `err.constraint` / the message. */
  pgConstraint: string;
  /** SQLite `table.column` token, as it appears in the better-sqlite3 message. */
  sqliteColumn: string;
}

/** The canvas-slug unique index, expressed for both dialects. */
export const SLUG_UNIQUE: UniqueTarget = {
  pgConstraint: "canvases_slug_uq",
  sqliteColumn: "canvases.slug",
};

interface DriverError {
  code?: unknown;
  message?: unknown;
  constraint?: unknown;
}

/** Match a single (unwrapped) driver error against the target. */
function matchOne(e: DriverError, target: UniqueTarget): boolean {
  const message = typeof e.message === "string" ? e.message : "";
  if (e.code === "SQLITE_CONSTRAINT_UNIQUE") {
    return message.includes(target.sqliteColumn);
  }
  if (e.code === "23505") {
    return e.constraint === target.pgConstraint || message.includes(target.pgConstraint);
  }
  return false;
}

export function isUniqueViolation(err: unknown, target: UniqueTarget): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as DriverError & { cause?: unknown };
  if (matchOne(e, target)) return true;
  // Drizzle nests the postgres/pglite DatabaseError under `.cause`.
  if (e.cause && typeof e.cause === "object") return matchOne(e.cause as DriverError, target);
  return false;
}
