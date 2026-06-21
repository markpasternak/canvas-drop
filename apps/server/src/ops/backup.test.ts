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

  it("orders every table after the tables it references (FK-safe restore order)", () => {
    // Restore inserts in this order with FK enforcement ON, so a child must never precede a
    // parent it references. Set-parity (above) can't catch a child-before-parent reordering;
    // this does. Edges are the schema's foreign keys (child -> referenced parent).
    const idx = (n: string) => (BACKUP_TABLE_ORDER as readonly string[]).indexOf(n);
    const fkEdges: ReadonlyArray<readonly [string, string]> = [
      ["oauth_codes", "oauth_clients"],
      ["sessions", "users"],
      ["mcp_tokens", "users"],
      ["audit_log", "users"],
      ["org_domains", "orgs"],
      ["org_members", "orgs"],
      ["org_members", "users"],
      ["teams", "orgs"],
      ["teams", "users"],
      ["team_members", "teams"],
      ["team_members", "users"],
      ["invitations", "users"],
      ["canvas_teams", "canvases"],
      ["canvas_teams", "teams"],
      ["canvases", "orgs"],
      ["canvases", "users"],
      ["canvas_allowlist", "canvases"],
      ["guest_invites", "canvases"],
      ["guest_sessions", "guest_invites"],
      ["versions", "canvases"],
      ["upload_sessions", "canvases"],
      ["drafts", "canvases"],
      ["usage_events", "canvases"],
      ["kv_entries", "canvases"],
      ["files", "canvases"],
      ["ai_usage", "canvases"],
      ["screenshot_jobs", "canvases"],
    ];
    for (const [child, parent] of fkEdges) {
      expect(idx(parent)).toBeGreaterThanOrEqual(0);
      expect(idx(child)).toBeGreaterThan(idx(parent));
    }
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

describe("cross-dialect restore (the driver-migration path)", () => {
  // The headline feature: a backup taken on one dialect restores losslessly into the OTHER,
  // with column types intact. The same-dialect round-trip can't catch a cross-dialect encoding
  // bug — source and target encode identically there — so exercise both crossings explicitly.
  const PAIRS: ReadonlyArray<readonly [Dialect, Dialect]> = [
    ["sqlite", "postgres"],
    ["postgres", "sqlite"],
  ];
  it.each(
    PAIRS,
  )("restores a %s backup into a fresh %s target with types intact", async (src, tgt) => {
    const source = src === "sqlite" ? await makeTestDb("sqlite") : await makeFreshPgTestDb();
    const srcStore = memStorage();
    const { user, canvas } = await seed(source, srcStore);

    const dir = await freshDir();
    const meta = await createBackup({ client: source, storage: srcStore, log }, dir);
    expect(meta.dialect).toBe(src);

    const target = tgt === "sqlite" ? await makeTestDb("sqlite") : await makeFreshPgTestDb();
    const tgtStore = memStorage();
    const summary = await restoreBackup({ client: target, storage: tgtStore, log }, dir);
    expect(summary.tableRows).toEqual(meta.tableRows);

    // Read back through the typed repositories (the app's real read path) to prove the row
    // crossed the dialect boundary with its types intact:
    const restoredUser = await usersRepository(target).findById(user.id);
    expect(restoredUser?.isAdmin).toBe(true); // boolean: sqlite int 0/1 <-> pg bool
    expect(restoredUser?.email).toBe("owner@example.com"); // text
    const restoredCanvas = await canvasesRepository(target).findById(canvas.id);
    expect(restoredCanvas?.slug).toBe("lucky-yak");
    expect(restoredCanvas?.title).toBe("Three.js demo");
    // JSON value fidelity (settings.value is a JSON column):
    expect(await settingsRepository(target).get("config.core.designSkin")).toBe("workshop");
    // Blobs serve verbatim on the target driver.
    const html = await tgtStore.get(`canvas/${canvas.id}/index.html`);
    expect(new TextDecoder().decode(html ?? new Uint8Array())).toContain("<h1>hi</h1>");

    await target.close();
    await source.close();
  });
});

describe.each(DIALECTS)("restore failure recovery + force [%s]", (dialect) => {
  it("is re-runnable after a mid-restore storage failure (blobs first, rows in a txn)", async () => {
    const source = await makeTestDb(dialect);
    const srcStore = memStorage();
    const { canvas } = await seed(source, srcStore);
    const dir = await freshDir();
    await createBackup({ client: source, storage: srcStore, log }, dir);

    // Restore into a fresh target whose storage fails on the 2nd put (mid blob copy). Blobs
    // are written BEFORE the row transaction, so the failed run must leave the DB empty.
    const target = await emptyTarget(dialect);
    await expect(
      restoreBackup({ client: target, storage: memStorage(2), log }, dir),
    ).rejects.toThrow(/storage down/);

    // Because the DB was left empty, a plain (non-force) retry is accepted, not blocked by
    // the empty-guard — the wedge the transaction + blobs-first ordering is meant to prevent.
    const summary = await restoreBackup({ client: target, storage: memStorage(), log }, dir);
    expect(summary.tableRows.canvases).toBe(1);
    expect((await canvasesRepository(target).findById(canvas.id))?.slug).toBe("lucky-yak");

    if (dialect === "sqlite") await target.close();
    await source.close();
  });

  it("force:true restores into an empty target (exercises the guard-bypass path)", async () => {
    const source = await makeTestDb(dialect);
    const srcStore = memStorage();
    await seed(source, srcStore);
    const dir = await freshDir();
    const meta = await createBackup({ client: source, storage: srcStore, log }, dir);

    const target = await emptyTarget(dialect);
    const summary = await restoreBackup({ client: target, storage: memStorage(), log }, dir, {
      force: true,
    });
    expect(summary.tableRows).toEqual(meta.tableRows);

    if (dialect === "sqlite") await target.close();
    await source.close();
  });
});
