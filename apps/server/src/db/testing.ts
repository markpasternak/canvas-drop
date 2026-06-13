import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { DbClient } from "./factory.js";
import { resolveMigrationsDir } from "./migrations-dir.js";

export type Dialect = "sqlite" | "postgres";

/** The dialects the suite runs against. CI parameterizes the leg per matrix job. */
export const DIALECTS: readonly Dialect[] = ["sqlite", "postgres"];

/**
 * Build an ephemeral, migrated database for tests:
 *   - sqlite   → better-sqlite3 in-memory
 *   - postgres → pglite (in-process WASM Postgres, no server)
 *
 * Both run the real generated migrations, so tests also verify migration
 * validity on each dialect.
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
      close: async () => {
        sqlite.close();
      },
    };
    await client.migrate();
    return client;
  }

  const pglite = new PGlite();
  const db = drizzlePglite(pglite, { schema: pgSchema });
  const client: DbClient = {
    dialect: "postgres",
    db,
    migrate: async () => {
      await migratePglite(db, { migrationsFolder: resolveMigrationsDir("pg") });
    },
    close: async () => {
      await pglite.close();
    },
  };
  await client.migrate();
  return client;
}
