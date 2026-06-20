/**
 * Portable backup & restore (M10 / BUILD_BRIEF §16). A backup is a self-describing
 * directory:
 *
 *   <dir>/meta.json            — format version, source dialect, row/blob counts, time
 *   <dir>/db/<table>.ndjson    — every row of every table, one JSON object per line
 *   <dir>/blobs/<key>          — every content-addressed storage object, verbatim
 *
 * It is **driver-agnostic on both axes**: the DB dump goes through drizzle (so it reads
 * the same from SQLite or Postgres) and the blob dump goes through the storage interface
 * (local or S3). That means a backup taken on `sqlite + local` restores cleanly into
 * `postgres + s3` and vice-versa — so this doubles as the supported migration path
 * (D10), and needs no `pg_dump`/`aws`/external binaries. The dual-dialect schema lockstep
 * (CLAUDE.md) is what makes a row portable: identical column names in both dialects.
 *
 * Scale note: dumps whole tables into memory per table — correct and simple at the
 * single-org (D13) target. A streaming/cursored variant is a future refinement.
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../db/factory.js";
import { runMigrations } from "../db/migrate.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";

/** Bumped only on a breaking change to the on-disk layout. Restore rejects other majors. */
export const BACKUP_FORMAT_VERSION = 1;

/**
 * Restore (and dump) order: parents before children, so a row's foreign-key targets
 * always exist by the time it's inserted — no need to disable FK enforcement, which keeps
 * it portable across SQLite *and* Postgres without superuser tricks. A test asserts this
 * list is exactly the set of tables in the schema, so adding a table without placing it
 * here fails CI (mirrors the dual-dialect parity guards).
 */
export const BACKUP_TABLE_ORDER = [
  "users",
  "allowed_emails",
  "settings",
  "oauth_clients",
  "oauth_codes",
  "sessions",
  "mcp_tokens",
  "audit_log",
  "canvases",
  "canvas_allowlist",
  "guest_invites",
  "guest_sessions",
  "versions",
  "upload_sessions",
  "drafts",
  "usage_events",
  "kv_entries",
  "files",
  "ai_usage",
  "screenshot_jobs",
] as const;

/** Rows per INSERT — bounds the bound-parameter count well under SQLite/Postgres limits. */
const INSERT_BATCH = 200;

/** A content-addressed blob key — `canvases/{id}/blobs/{sha256-hex}`. Only these carry
 *  their integrity hash in the key; other storage keys (e.g. `screenshots/…`) don't and
 *  are copied verbatim without a hash check. Mirrors upload/service.ts's staged check. */
const CONTENT_ADDRESSED_KEY = /^canvases\/[^/]+\/blobs\/([0-9a-f]{64})$/;

export interface BackupDeps {
  client: DbClient;
  storage: StorageDriver;
  log: Logger;
}

export interface BackupMeta {
  formatVersion: number;
  createdAt: string;
  dialect: DbClient["dialect"];
  tableRows: Record<string, number>;
  blobCount: number;
  blobBytes: number;
}

export interface RestoreSummary {
  tableRows: Record<string, number>;
  blobCount: number;
  blobBytes: number;
}

type Row = Record<string, unknown>;

// The two schemas are kept in lockstep (CLAUDE.md dual-dialect rule), so a row read from
// one dialect inserts cleanly into the other, and drizzle's query builders behave
// identically at runtime — only the compile-time HKT differs. We cross that boundary in
// exactly one place, here, rather than threading a dialect union through every call.
// biome-ignore lint/suspicious/noExplicitAny: single documented dialect-crossing boundary (see above).
type AnyQueryDb = any;

/** name → drizzle table object, for the client's dialect. */
function tableMap(client: DbClient): Map<string, unknown> {
  const map = new Map<string, unknown>();
  const entries =
    client.dialect === "sqlite"
      ? Object.values(sqliteSchema).filter((v) => is(v, SQLiteTable))
      : Object.values(pgSchema).filter((v) => is(v, PgTable));
  for (const t of entries) map.set(getTableName(t as SQLiteTable | PgTable), t);
  return map;
}

function requireTable(tables: Map<string, unknown>, name: string): unknown {
  const t = tables.get(name);
  if (!t) throw new Error(`backup: schema has no table "${name}" (BACKUP_TABLE_ORDER drift?)`);
  return t;
}

async function selectAll(client: DbClient, table: unknown): Promise<Row[]> {
  return (client.db as AnyQueryDb).select().from(table);
}

async function insertAll(db: AnyQueryDb, table: unknown, rows: Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    await db.insert(table).values(rows.slice(i, i + INSERT_BATCH));
  }
}

/**
 * Run `fn` against a transactional executor so the multi-table insert is atomic. Postgres
 * (the production default) gets a real `db.transaction`, so a mid-restore failure rolls the
 * DB back to empty and a plain retry's empty-guard passes instead of wedging. better-sqlite3's
 * drizzle `transaction()` rejects an async callback and its single-writer connection
 * serializes anyway, so sqlite runs `fn(db)` directly (no rollback — docs/ops.md covers the
 * manual recovery). Mirrors the dialect-safe pattern in db/repositories/canvases.ts.
 */
async function inTransaction(
  client: DbClient,
  fn: (db: AnyQueryDb) => Promise<void>,
): Promise<void> {
  const db = client.db as AnyQueryDb;
  if (client.dialect === "sqlite") return fn(db);
  return db.transaction(fn);
}

/** Recursively yield absolute file paths under `root` (missing root → nothing). */
async function* walkFiles(root: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return;
    throw err;
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

/**
 * Write a complete backup of the DB + content-addressed storage into `destDir`. The
 * caller owns scheduling, retention, and any compression (the docs' cron `tar`s the dir).
 */
export async function createBackup(deps: BackupDeps, destDir: string): Promise<BackupMeta> {
  const { client, storage, log } = deps;
  const tables = tableMap(client);
  await mkdir(join(destDir, "db"), { recursive: true });

  const tableRows: Record<string, number> = {};
  for (const name of BACKUP_TABLE_ORDER) {
    const rows = await selectAll(client, requireTable(tables, name));
    const body = rows.map((r) => JSON.stringify(r)).join("\n");
    await writeFile(join(destDir, "db", `${name}.ndjson`), rows.length ? `${body}\n` : "");
    tableRows[name] = rows.length;
  }

  let blobCount = 0;
  let blobBytes = 0;
  for (const key of await storage.list("")) {
    const bytes = await storage.get(key);
    if (!bytes) continue; // listed-then-deleted race — skip, not fatal
    const dest = join(destDir, "blobs", key);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
    blobCount += 1;
    blobBytes += bytes.byteLength;
  }

  const meta: BackupMeta = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    dialect: client.dialect,
    tableRows,
    blobCount,
    blobBytes,
  };
  await writeFile(join(destDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  const totalRows = Object.values(tableRows).reduce((a, b) => a + b, 0);
  log.info({ destDir, totalRows, blobCount, blobBytes }, "backup complete");
  return meta;
}

export interface RestoreOptions {
  /** Skip the empty-target guard (advanced — restoring over existing data risks PK
   *  collisions). The drill restores into a fresh, empty DB + storage. */
  force?: boolean;
}

/**
 * Restore a backup produced by {@link createBackup} into the configured DB + storage.
 *
 * **Integrity-first.** It pre-flights the WHOLE backup against `meta.json` — every table's
 * row count, the blob count + total bytes, AND the sha256 of every content-addressed blob
 * against the hash in its key — and refuses on any mismatch BEFORE writing a single row or
 * blob. A backup whose `meta.json` survived a partial transfer but whose `db/*.ndjson` or
 * blobs were dropped, truncated, or corrupted (even a same-length byte flip) is rejected,
 * never restored silently short (the worst failure for a recovery tool). It then runs
 * migrations (so the target can be an empty, un-migrated DB), refuses a non-empty DB unless
 * `force`, writes blobs first (idempotent content-addressed puts), then inserts rows
 * parent-first inside a transaction — so a mid-restore failure on Postgres rolls the DB back
 * to empty and a plain retry succeeds rather than wedging (docs/ops.md §restore).
 */
export async function restoreBackup(
  deps: BackupDeps,
  srcDir: string,
  opts: RestoreOptions = {},
): Promise<RestoreSummary> {
  const { client, storage, log } = deps;

  const meta = JSON.parse(await readFile(join(srcDir, "meta.json"), "utf8")) as BackupMeta;
  if (meta.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `restore: unsupported backup format v${meta.formatVersion} (this build reads v${BACKUP_FORMAT_VERSION})`,
    );
  }

  // --- Pre-flight: load + count everything and verify it against meta.json BEFORE any
  // write. createBackup writes a file for EVERY table (empty ones included), so a missing
  // db/<table>.ndjson is corruption, not an empty table. ---
  const parsed = new Map<string, Row[]>();
  const tableRows: Record<string, number> = {};
  for (const name of BACKUP_TABLE_ORDER) {
    let text: string;
    try {
      text = await readFile(join(srcDir, "db", `${name}.ndjson`), "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        throw new Error(`restore: backup is missing db/${name}.ndjson — incomplete or corrupt`);
      }
      throw err;
    }
    const rows = text
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Row);
    parsed.set(name, rows);
    tableRows[name] = rows.length;
  }
  const rowDrift = BACKUP_TABLE_ORDER.filter((n) => tableRows[n] !== (meta.tableRows?.[n] ?? 0));
  if (rowDrift.length > 0) {
    const detail = rowDrift.map(
      (n) => `${n}: have ${tableRows[n]}, meta ${meta.tableRows?.[n] ?? 0}`,
    );
    throw new Error(
      `restore: row counts don't match meta.json (${detail.join("; ")}) — corrupt backup`,
    );
  }

  const blobsRoot = join(srcDir, "blobs");
  const blobKeys: string[] = [];
  let blobBytes = 0;
  for await (const file of walkFiles(blobsRoot)) {
    const key = relative(blobsRoot, file).split(sep).join("/");
    // Read once to both size AND integrity-check: a content-addressed blob whose bytes no
    // longer hash to the key is corruption that count+size can't catch (a same-length byte
    // flip), so verify it HERE — before any write — not while putting it.
    const bytes = await readFile(file);
    const hash = key.match(CONTENT_ADDRESSED_KEY);
    if (hash) {
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== hash[1]) {
        throw new Error(`restore: blob "${key}" is corrupt (sha256 ${actual} ≠ key hash)`);
      }
    }
    blobKeys.push(key);
    blobBytes += bytes.byteLength;
  }
  if (blobKeys.length !== meta.blobCount || blobBytes !== meta.blobBytes) {
    throw new Error(
      `restore: blob count/size don't match meta.json (have ${blobKeys.length}/${blobBytes}, ` +
        `meta ${meta.blobCount}/${meta.blobBytes}) — incomplete or corrupt backup`,
    );
  }

  // --- Past pre-flight: the backup is complete and every content-addressed blob is verified.
  // Write it into the target in a re-runnable order: blobs first (idempotent content-addressed
  // puts), then all rows in one transaction. On Postgres a mid-insert failure rolls the DB back
  // to empty so a plain retry's empty-guard passes; the already-written blobs re-put identically. ---
  await runMigrations(client); // create the schema on a fresh target (idempotent)
  const tables = tableMap(client);

  if (!opts.force) {
    for (const name of BACKUP_TABLE_ORDER) {
      const existing = await selectAll(client, requireTable(tables, name));
      if (existing.length > 0) {
        throw new Error(
          `restore: target DB is not empty ("${name}" has ${existing.length} row(s)). ` +
            "Restore into a fresh DB, or pass force to override.",
        );
      }
    }
  }

  for (const key of blobKeys) {
    await storage.put(key, await readFile(join(blobsRoot, key)));
  }

  await inTransaction(client, async (db) => {
    for (const name of BACKUP_TABLE_ORDER) {
      await insertAll(db, requireTable(tables, name), parsed.get(name) ?? []);
    }
  });

  const totalRows = Object.values(tableRows).reduce((a, b) => a + b, 0);
  log.info({ srcDir, totalRows, blobCount: blobKeys.length, blobBytes }, "restore complete");
  return { tableRows, blobCount: blobKeys.length, blobBytes };
}
