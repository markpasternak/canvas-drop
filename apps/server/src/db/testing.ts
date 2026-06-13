import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { DbClient } from "./factory.js";
import { resolveMigrationsDir } from "./migrations-dir.js";

export type Dialect = "sqlite" | "postgres";

/**
 * The dialects the suite runs against. When CANVAS_DROP_DB is set (the CI matrix
 * legs and the test:sqlite / test:pg scripts), run only that dialect so the legs
 * are genuinely split; otherwise (bare `pnpm test`) run both in-process.
 */
const envDialect = process.env.CANVAS_DROP_DB as Dialect | undefined;
export const DIALECTS: readonly Dialect[] =
  envDialect === "sqlite" || envDialect === "postgres" ? [envDialect] : ["sqlite", "postgres"];

/**
 * Build an ephemeral, migrated database for tests:
 *   - sqlite   → better-sqlite3 in-memory
 *   - postgres → pglite (in-process WASM Postgres, no server)
 *
 * Both run the real generated migrations, so tests also verify migration
 * validity on each dialect.
 *
 * SQLite boots a fresh in-memory database per call (near-instant). Postgres
 * reuses a single migrated PGlite instance per worker and resets it between
 * tests — booting WASM Postgres + replaying every migration on each of the
 * suite's ~hundreds of DB tests was the dominant cost of the `test:pg` leg
 * (each test paid a flat ~1.4s). See `makeFreshPgTestDb` for the rare test
 * that genuinely needs a virgin database.
 */
export async function makeTestDb(dialect: Dialect): Promise<DbClient> {
  if (dialect === "sqlite") {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzleSqlite(sqlite, { schema: sqliteSchema });
    const client: DbClient = {
      dialect: "sqlite",
      db,
      migrate: async () => {
        migrateSqlite(db, { migrationsFolder: resolveMigrationsDir("sqlite") });
      },
      ping: async () => {
        db.run(sql`SELECT 1`);
      },
      close: async () => {
        sqlite.close();
      },
    };
    await client.migrate();
    return client;
  }

  const shared = await acquireSharedPg();
  // Reset on acquire (not on close) so every test starts from a clean schema
  // regardless of whether its suite remembers to call close() — and so a leaked
  // row from one test can never bleed into the next.
  await truncateAllTables(shared);
  return shared.client;
}

/**
 * A migrated PGlite instance shared across the tests in one vitest worker.
 * Vitest isolates by file by default, so in practice this amortises the WASM
 * boot + migration replay to once per test file instead of once per test.
 */
interface SharedPg {
  pglite: PGlite;
  // biome-ignore lint/suspicious/noExplicitAny: matches PgClient.db's base PgDatabase HKT
  db: PgDatabase<any, typeof pgSchema>;
  client: DbClient;
  /** Public, non-bookkeeping tables to truncate between tests (cached after first lookup). */
  tables: string[] | null;
}

let sharedPgPromise: Promise<SharedPg> | null = null;

function acquireSharedPg(): Promise<SharedPg> {
  if (sharedPgPromise) return sharedPgPromise;
  sharedPgPromise = (async () => {
    const pglite = new PGlite();
    const db = drizzlePglite(pglite, { schema: pgSchema });
    const client: DbClient = {
      dialect: "postgres",
      db,
      migrate: async () => {
        // Idempotent: drizzle records applied migrations in the `drizzle` schema,
        // which truncateAllTables never touches, so a repeat call is a no-op.
        await migratePglite(db, { migrationsFolder: resolveMigrationsDir("pg") });
      },
      ping: async () => {
        await db.execute(sql`SELECT 1`);
      },
      // No-op: the instance is reused for the next test and torn down with the
      // worker. Cleanliness is guaranteed by the reset-on-acquire in makeTestDb.
      close: async () => {},
    };
    await client.migrate();
    return { pglite, db, client, tables: null };
  })();
  return sharedPgPromise;
}

async function truncateAllTables(shared: SharedPg): Promise<void> {
  if (!shared.tables) {
    const rows = await shared.db.execute<{ tablename: string }>(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    // PGlite returns { rows }, pg returns the array directly — normalise both.
    const list = (Array.isArray(rows) ? rows : rows.rows) as { tablename: string }[];
    shared.tables = list.map((r) => r.tablename);
  }
  if (shared.tables.length === 0) return;
  const idents = shared.tables.map((t) => `"${t}"`).join(", ");
  await shared.db.execute(sql.raw(`TRUNCATE TABLE ${idents} RESTART IDENTITY CASCADE`));
}

/**
 * A virgin, freshly-migrated PGlite instance — its own isolated database, not
 * the shared one. Use only when a test must observe a clean migration apply
 * (e.g. migration-idempotency checks). Caller owns close().
 */
export async function makeFreshPgTestDb(): Promise<DbClient> {
  const pglite = new PGlite();
  const db = drizzlePglite(pglite, { schema: pgSchema });
  const client: DbClient = {
    dialect: "postgres",
    db,
    migrate: async () => {
      await migratePglite(db, { migrationsFolder: resolveMigrationsDir("pg") });
    },
    ping: async () => {
      await db.execute(sql`SELECT 1`);
    },
    close: async () => {
      await pglite.close();
    },
  };
  await client.migrate();
  return client;
}
