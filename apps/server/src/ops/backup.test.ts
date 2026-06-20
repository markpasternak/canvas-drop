import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { settingsRepository } from "../db/repositories/settings.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, type Dialect, makeFreshPgTestDb, makeTestDb } from "../db/testing.js";
import type { Logger } from "../log/logger.js";
import { memStorage } from "../storage/mem.js";
import { BACKUP_TABLE_ORDER, createBackup, restoreBackup } from "./backup.js";

const log = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return log;
  },
} as unknown as Logger;

const enc = new TextEncoder();

/** Seed a small but cross-cutting dataset: a user, a canvas (FK → user), a JSON
 *  settings row, and two content-addressed blobs. */
async function seed(db: DbClient, storage: ReturnType<typeof memStorage>) {
  const user = await usersRepository(db).upsert({
    providerSub: "sub-1",
    email: "owner@example.com",
    name: "Owner",
    isAdmin: true,
  });
  const canvas = await canvasesRepository(db).create({
    ownerId: user.id,
    slug: "lucky-yak",
    apiKeyHash: "hash-abc",
    title: "Three.js demo",
  });
  await settingsRepository(db).set("config.core.designSkin", "workshop");
  await storage.put(`canvas/${canvas.id}/index.html`, enc.encode("<!doctype html><h1>hi</h1>"));
  await storage.put(`canvas/${canvas.id}/app.js`, enc.encode("console.log(1)"));
  return { user, canvas };
}

/** All file paths under `root`, relative + posix-keyed, sorted. */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(relative(root, full).split(sep).join("/"));
    }
  }
  await walk(root);
  return out.sort();
}

/** A backup dir reduced to comparable content: each table as a SORTED line-set (row
 *  order is not guaranteed across dialects/inserts) + the blob tree + bytes. */
async function snapshot(dir: string) {
  const tables: Record<string, string[]> = {};
  for (const name of BACKUP_TABLE_ORDER) {
    const text = await readFile(join(dir, "db", `${name}.ndjson`), "utf8");
    tables[name] = text.split("\n").filter(Boolean).sort();
  }
  const blobRoot = join(dir, "blobs");
  const blobKeys = await listFiles(blobRoot).catch(() => []);
  const blobs: Record<string, string> = {};
  for (const key of blobKeys) blobs[key] = (await readFile(join(blobRoot, key))).toString("base64");
  return { tables, blobs };
}

const tmpDirs: string[] = [];
async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cd-backup-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) await rm(tmpDirs.pop() as string, { recursive: true, force: true });
});

/** A virgin, empty, migrated target DB — a SEPARATE database from the source (the
 *  shared PGlite is reused for the source, so pg needs a fresh isolated instance). */
async function emptyTarget(dialect: Dialect): Promise<DbClient> {
  return dialect === "sqlite" ? makeTestDb("sqlite") : makeFreshPgTestDb();
}

describe("BACKUP_TABLE_ORDER", () => {
  it("is exactly the set of tables in both dialect schemas (so no table escapes backup)", () => {
    const sqliteNames = Object.values(sqliteSchema)
      .filter((v) => is(v, SQLiteTable))
      .map((t) => getTableName(t as SQLiteTable))
      .sort();
    const pgNames = Object.values(pgSchema)
      .filter((v) => is(v, PgTable))
      .map((t) => getTableName(t as PgTable))
      .sort();
    expect([...BACKUP_TABLE_ORDER].sort()).toEqual(sqliteNames);
    expect(pgNames).toEqual(sqliteNames); // dual-dialect lockstep
    expect(new Set(BACKUP_TABLE_ORDER).size).toBe(BACKUP_TABLE_ORDER.length); // no duplicates
  });
});

// Integrity guards are dialect-independent (they read the backup dir + verify it against
// meta.json BEFORE the DB write), so exercise them on sqlite for speed.
describe("restore integrity guards", () => {
  async function backupWith(extraBlob?: { key: string; bytes: Uint8Array }): Promise<string> {
    const src = await makeTestDb("sqlite");
    const store = memStorage();
    await seed(src, store);
    if (extraBlob) await store.put(extraBlob.key, extraBlob.bytes);
    const dir = await freshDir();
    await createBackup({ client: src, storage: store, log }, dir);
    await src.close();
    return dir;
  }

  async function expectRestoreToThrow(dir: string, re: RegExp): Promise<void> {
    const target = await makeTestDb("sqlite");
    await expect(
      restoreBackup({ client: target, storage: memStorage(), log }, dir),
    ).rejects.toThrow(re);
    await target.close();
  }

  it("refuses a backup whose table file was truncated (row-count mismatch vs meta)", async () => {
    const dir = await backupWith();
    await writeFile(join(dir, "db", "canvases.ndjson"), ""); // meta says 1 canvas, now 0
    await expectRestoreToThrow(dir, /row counts don't match|corrupt/i);
  });

  it("refuses a backup with a missing table file", async () => {
    const dir = await backupWith();
    await rm(join(dir, "db", "settings.ndjson"), { force: true });
    await expectRestoreToThrow(dir, /missing db\/settings|corrupt/i);
  });

  it("refuses a backup with a dropped blob (count/size mismatch vs meta)", async () => {
    const dir = await backupWith();
    await rm(join(dir, "blobs", "canvas"), { recursive: true, force: true }); // drop the seeded blobs
    await expectRestoreToThrow(dir, /blob count\/size|corrupt/i);
  });

  it("detects a corrupted content-addressed blob (sha256 ≠ key hash)", async () => {
    const bytes = new TextEncoder().encode("const x = 42;");
    const key = `canvases/c-int/blobs/${createHash("sha256").update(bytes).digest("hex")}`;
    const dir = await backupWith({ key, bytes });
    // Same byte length so it clears the size pre-flight, different content → hash mismatch.
    await writeFile(join(dir, "blobs", key), new TextEncoder().encode("const x = 43;"));
    await expectRestoreToThrow(dir, /is corrupt \(sha256|key hash/i);
  });
});

describe.each(DIALECTS)("backup/restore round-trip [%s]", (dialect) => {
  it("restores into a fresh DB + storage with byte-identical content", async () => {
    const source = await makeTestDb(dialect);
    const srcStore = memStorage();
    const { canvas } = await seed(source, srcStore);

    const backupDir = await freshDir();
    const meta = await createBackup({ client: source, storage: srcStore, log }, backupDir);
    expect(meta.dialect).toBe(dialect);
    expect(meta.tableRows.users).toBe(1);
    expect(meta.tableRows.canvases).toBe(1);
    expect(meta.tableRows.settings).toBe(1);
    expect(meta.blobCount).toBe(2);

    // Restore into a genuinely separate, empty DB + a fresh storage driver.
    const target = await emptyTarget(dialect);
    const tgtStore = memStorage();
    const summary = await restoreBackup({ client: target, storage: tgtStore, log }, backupDir);
    expect(summary.tableRows).toEqual(meta.tableRows);
    expect(summary.blobCount).toBe(2);

    // Black-box fidelity: a backup of the restored target equals the original backup.
    const reDir = await freshDir();
    await createBackup({ client: target, storage: tgtStore, log }, reDir);
    expect(await snapshot(reDir)).toEqual(await snapshot(backupDir));

    // Concrete spot-check: the restored DB is actually queryable + correct.
    const restored = await canvasesRepository(target).findById(canvas.id);
    expect(restored?.slug).toBe("lucky-yak");
    expect(restored?.title).toBe("Three.js demo");
    // And the restored storage serves the blobs verbatim.
    const html = await tgtStore.get(`canvas/${canvas.id}/index.html`);
    expect(new TextDecoder().decode(html ?? new Uint8Array())).toContain("<h1>hi</h1>");

    if (dialect === "sqlite") await target.close();
    await source.close();
  });

  it("refuses to restore into a non-empty DB unless forced", async () => {
    const source = await makeTestDb(dialect);
    const srcStore = memStorage();
    await seed(source, srcStore);
    const dir = await freshDir();
    await createBackup({ client: source, storage: srcStore, log }, dir);

    const target = await emptyTarget(dialect);
    await restoreBackup({ client: target, storage: memStorage(), log }, dir); // first restore OK
    // Second restore must refuse — the target now has rows.
    await expect(
      restoreBackup({ client: target, storage: memStorage(), log }, dir),
    ).rejects.toThrow(/not empty/i);

    if (dialect === "sqlite") await target.close();
    await source.close();
  });
});
