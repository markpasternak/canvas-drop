import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "@canvas-drop/shared";
import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { resolveMigrationsDir } from "./migrations-dir.js";

/**
 * A database client for the active dialect (KTD-1). Production builds either a
 * better-sqlite3 client or a node-postgres client; the Postgres `db` is typed
 * as the base `PgDatabase` so the test-only pglite driver also satisfies it.
 * `migrate()` is bound to the matching migrator + folder by whoever constructs
 * the client.
 */
export interface SqliteClient {
  dialect: "sqlite";
  db: BetterSQLite3Database<typeof sqliteSchema>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}
export interface PgClient {
  dialect: "postgres";
  // biome-ignore lint/suspicious/noExplicitAny: base PgDatabase HKT so node-postgres AND pglite both satisfy it
  db: PgDatabase<any, typeof pgSchema>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}
export type DbClient = SqliteClient | PgClient;

/** Construct the configured database client (BUILD_BRIEF.md D10, §10). */
export function makeDb(config: Config): DbClient {
  if (config.db.driver === "sqlite") {
    if (config.db.path !== ":memory:") {
      mkdirSync(dirname(config.db.path), { recursive: true });
    }
    const sqlite = new Database(config.db.path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzleSqlite(sqlite, { schema: sqliteSchema });
    return {
      dialect: "sqlite",
      db,
      migrate: async () => {
        migrateSqlite(db, { migrationsFolder: resolveMigrationsDir("sqlite") });
      },
      close: async () => {
        sqlite.close();
      },
    };
  }

  const pool = new Pool({ connectionString: config.db.url });
  const db = drizzlePg(pool, { schema: pgSchema });
  return {
    dialect: "postgres",
    db,
    migrate: async () => {
      await migratePg(db, { migrationsFolder: resolveMigrationsDir("pg") });
    },
    close: async () => {
      await pool.end();
    },
  };
}
