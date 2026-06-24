import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@canvas-drop/shared";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { makeDb } from "./factory.js";
import { runMigrations } from "./migrate.js";
import { resolveMigrationsDir } from "./migrations-dir.js";

/**
 * Regression for the production incident where the access-ladder migration (0011)
 * crash-looped the server: a SQLite table-recreation (`DROP TABLE canvases`) on a
 * POPULATED table fails when the connection has foreign_keys ON (our runtime), because
 * DROP does an implicit row-delete that violates child-table FKs. The fix is in
 * factory.ts's migrate() (toggle FK off around the migrator). The normal test harness
 * migrates EMPTY DBs, so it can't catch this — here we migrate a real, populated,
 * pre-0011 database through the actual factory path.
 */
interface JournalEntry {
  idx: number;
  tag: string;
}

/** Build a temp migrations folder containing only the migrations BEFORE `cutoffTag`. */
function subsetMigrationsBefore(cutoffPrefix: string): string {
  const src = resolveMigrationsDir("sqlite");
  const journal = JSON.parse(readFileSync(join(src, "meta", "_journal.json"), "utf8")) as {
    version: string;
    dialect: string;
    entries: JournalEntry[];
  };
  // Keep only entries strictly BEFORE the cutoff (by journal order), so phase 1 lands
  // exactly on the pre-cutoff schema and phase 2 applies the cutoff migration onward.
  const cut = journal.entries.findIndex((e) => e.tag.startsWith(cutoffPrefix));
  const kept = cut === -1 ? journal.entries : journal.entries.slice(0, cut);
  const dest = mkdtempSync(join(tmpdir(), "cd-premig-"));
  mkdirSync(join(dest, "meta"), { recursive: true });
  for (const e of kept) copyFileSync(join(src, `${e.tag}.sql`), join(dest, `${e.tag}.sql`));
  writeFileSync(join(dest, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  return dest;
}

describe("migrating a populated database (FK-on table-recreation regression)", () => {
  let dbFile: string;
  afterEach(() => {
    // temp files live under the OS temp dir; nothing else to tear down
  });

  it("applies the access-ladder migrations on a populated DB with foreign_keys ON", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "cd-mig-"));
    dbFile = join(workdir, "canvasdrop.db");

    // --- Phase 1: build the pre-0011 schema with real rows (a canvas + a child KV row,
    //     so the 0011 DROP TABLE would do an FK-violating implicit delete). ---
    const pre = subsetMigrationsBefore("0011");
    const seed = new Database(dbFile);
    const seedDb = drizzleSqlite(seed);
    migrateSqlite(seedDb, { migrationsFolder: pre });
    seed.exec(`
      INSERT INTO users (id, provider_sub, email, name, created_at)
        VALUES ('u1','sub-1','u@example.com','U',0);
      INSERT INTO canvases (id, slug, owner_id, api_key_hash, shared, created_at, updated_at)
        VALUES ('c1','slug-1','u1','h1',1,0,0);
      INSERT INTO canvases (id, slug, owner_id, api_key_hash, shared, gallery_listed, created_at, updated_at)
        VALUES ('c-gallery','slug-gallery','u1','h-gallery',1,1,0,0);
      INSERT INTO kv_entries (canvas_id, scope, key, value, updated_by, updated_at)
        VALUES ('c1','shared','k','"v"','u1',0);
    `);
    seed.close();

    // --- Phase 2: the unit under test — the real factory migrate() (FK ON connection)
    //     applies the remaining migrations (0011–) on the populated DB. ---
    const config = loadConfig({ CANVAS_DROP_DB: "sqlite", CANVAS_DROP_SQLITE_PATH: dbFile });
    const client = makeDb(config);
    if (client.dialect !== "sqlite") throw new Error("expected a sqlite client");
    await expect(runMigrations(client)).resolves.toBeUndefined();

    // Data preserved + shared→access mapped; new table present; integrity intact.
    const access = client.db.all<{ access: string }>(
      sql`SELECT access FROM canvases WHERE id = 'c1'`,
    );
    expect(access[0]?.access).toBe("whole_org"); // shared=1 → whole_org
    const kv = client.db.all(sql`SELECT key FROM kv_entries WHERE canvas_id = 'c1'`);
    expect(kv).toHaveLength(1); // child row survived the canvases rebuild
    client.db.all(sql`SELECT 1 FROM allowed_emails`); // 0016 table exists (no throw)

    // 0026 tenancy (plan 002 U1): the canvases recreate added a nullable org_id that
    // must be NULL for pre-existing rows (the broken drizzle SELECT pulled org_id from
    // the OLD table — this asserts the hand-fix), the org tables exist, and the access
    // CHECK now reserves 'team' while still rejecting bogus rungs.
    const orgScoped = client.db.all<{ org_id: string | null }>(
      sql`SELECT org_id FROM canvases WHERE id = 'c1'`,
    );
    expect(orgScoped[0]?.org_id).toBeNull();
    const discovery = client.db.all<{ discoverability: string }>(
      sql`SELECT discoverability FROM canvases WHERE id = 'c1'`,
    );
    expect(discovery[0]?.discoverability).toBe("link_only");
    const listedDiscovery = client.db.all<{ discoverability: string }>(
      sql`SELECT discoverability FROM canvases WHERE id = 'c-gallery'`,
    );
    expect(listedDiscovery[0]?.discoverability).toBe("listed");
    client.db.all(sql`SELECT 1 FROM orgs`); // table exists (no throw)
    client.db.all(sql`SELECT 1 FROM org_domains`); // table exists (no throw)
    // reserved 'team' value passes the CHECK (decideCanvasAccess rejects it at runtime in P1).
    expect(() =>
      client.db.run(
        sql`INSERT INTO canvases (id, slug, owner_id, api_key_hash, access, created_at, updated_at)
            VALUES ('c2','slug-2','u1','h2','team',0,0)`,
      ),
    ).not.toThrow();
    // a bogus access value is still rejected by the CHECK.
    expect(() =>
      client.db.run(
        sql`INSERT INTO canvases (id, slug, owner_id, api_key_hash, access, created_at, updated_at)
            VALUES ('c3','slug-3','u1','h3','nope',0,0)`,
      ),
    ).toThrow();
    // 0032 discoverability: populated rows are backfilled, and invalid enum values
    // are rejected by the new CHECK constraint.
    expect(() =>
      client.db.run(
        sql`INSERT INTO canvases (id, slug, owner_id, api_key_hash, access, discoverability, created_at, updated_at)
            VALUES ('c4','slug-4','u1','h4','whole_org','broadcast',0,0)`,
      ),
    ).toThrow();

    const violations = client.db.all(sql`PRAGMA foreign_key_check`);
    expect(violations).toHaveLength(0);
    await client.close();
  });
});
