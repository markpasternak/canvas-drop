// Invoked only by container-smoke.mjs inside its disposable Docker containers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const bytes = Buffer.from("<!doctype html><title>Upgrade fixture</title><h1>Canvas survives</h1>");
const hash = createHash("sha256").update(bytes).digest("hex");
const blobKey = `canvases/smoke-canvas/blobs/${hash}`;
const [mode, dbPath, storagePath] = process.argv.slice(2);
assert.equal(process.getuid(), 1001, "the drill must run as the image's non-root user");

async function files(root, prefix = "") {
  const output = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) output.push(...(await files(root, path)));
    else output.push(path);
  }
  return output.sort();
}

if (mode === "seed") {
  assert.equal(Number(process.versions.node.split(".")[0]), 24);
  const require = createRequire("/legacy/package.json");
  assert.equal(require("better-sqlite3/package.json").version, "12.11.1");
  const Database = require("better-sqlite3");
  const { drizzle } = require("drizzle-orm/better-sqlite3");
  const { migrate } = require("drizzle-orm/better-sqlite3/migrator");
  const db = new Database("/data/source.db");
  try {
    db.pragma("journal_mode = WAL");
    migrate(drizzle(db), { migrationsFolder: "/app/drizzle/sqlite" });
    db.pragma("foreign_keys = ON");
    db.prepare(`INSERT INTO users (id, provider_sub, email, name, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      "smoke-user",
      "proxy:smoke@example.com",
      "smoke@example.com",
      "Smoke Owner",
      1,
    );
    db.prepare(`INSERT INTO canvases
      (id, slug, owner_id, api_key_hash, title, publication_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "smoke-canvas",
      "native-upgrade-smoke",
      "smoke-user",
      "fixture-not-a-real-api-key-hash",
      "Canvas upgrade fixture",
      "fixture-publication-token",
      1,
      1,
    );
    db.prepare(`INSERT INTO kv_entries (canvas_id, scope, key, value, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      "smoke-canvas",
      "shared",
      "fixture",
      JSON.stringify({ survives: true, count: 42 }),
      "smoke-user",
      1,
    );
    console.log("legacy fixture:", process.version, db.prepare("SELECT sqlite_version()").get());
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  const path = join("/data/source-storage", blobKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
} else if (mode === "database") {
  assert.equal(Number(process.versions.node.split(".")[0]), 26);
  const require = createRequire("/app/apps/server/package.json");
  const version = require("better-sqlite3/package.json").version;
  assert.equal(Number(version.split(".")[0]), 13);
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(
      db.prepare("SELECT name FROM users WHERE id = ?").get("smoke-user").name,
      "Smoke Owner",
    );
    assert.equal(
      db.prepare("SELECT title FROM canvases WHERE id = ?").get("smoke-canvas").title,
      "Canvas upgrade fixture",
    );
    const value = db
      .prepare("SELECT value FROM kv_entries WHERE canvas_id = ? AND key = ?")
      .get("smoke-canvas", "fixture").value;
    assert.deepEqual(JSON.parse(value), { survives: true, count: 42 });
    console.log(
      "upgraded fixture:",
      process.version,
      version,
      db.prepare("SELECT sqlite_version()").get(),
    );
  } finally {
    db.close();
  }
  assert.deepEqual(await readFile(join(storagePath, blobKey)), bytes);
} else if (mode === "backups") {
  const { BACKUP_TABLE_ORDER } = await import("../apps/server/dist/ops/backup.js");
  const before = "/data/backup-before";
  const after = "/data/backup-after";
  const expected = BACKUP_TABLE_ORDER.map((table) => `${table}.ndjson`).sort();
  assert.deepEqual(await files(join(before, "db")), expected);
  assert.deepEqual(await files(join(after, "db")), expected);
  for (const file of expected) {
    const rows = async (root) =>
      (await readFile(join(root, "db", file), "utf8")).split("\n").filter(Boolean).sort();
    assert.deepEqual(await rows(after), await rows(before), `table changed: ${file}`);
  }
  const keys = await files(join(before, "blobs"));
  assert.deepEqual(keys, [blobKey]);
  assert.deepEqual(await files(join(after, "blobs")), keys);
  for (const key of keys) {
    assert.deepEqual(
      await readFile(join(after, "blobs", key)),
      await readFile(join(before, "blobs", key)),
      `blob changed: ${key}`,
    );
  }
  console.log(`backup fidelity: ${expected.length} tables and ${keys.length} blob checked`);
} else if (mode === "http") {
  const origin = "http://127.0.0.1:3000";
  const headers = { Host: "canvas.example.com" };
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${origin}/healthz`, {
        headers,
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* The server may still be applying migrations. */
    }
    await delay(1000);
  }
  assert.ok(healthy, "compiled server did not become healthy");
  for (const [path, type] of [
    ["/welcome", "text/html"],
    ["/docs/authoring/create-and-publish", "text/html"],
    ["/docs/mermaid.js", "application/javascript"],
    ["/docs/assets/landing-carousel.js", "application/javascript"],
    ["/docs/assets/landing-dashboard.webp", "image/webp"],
    ["/og.png", "image/png"],
    ["/skill.zip", "application/zip"],
  ]) {
    const response = await fetch(`${origin}${path}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, `${path} is missing from the image`);
    assert.ok(response.headers.get("content-type")?.startsWith(type), `${path} content type`);
    assert.ok((await response.arrayBuffer()).byteLength > 100, `${path} is empty`);
  }
  const signedInHeaders = {
    ...headers,
    "X-Auth-Request-Email": "smoke@example.com",
    "X-Auth-Request-Preferred-Username": "Smoke Owner",
  };
  const dashboard = await fetch(`${origin}/`, {
    headers: signedInHeaders,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(dashboard.status, 200);
  const html = await dashboard.text();
  assert.match(html, /id="root"/);
  const asset = html.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
  assert.ok(asset, "built dashboard script was not referenced");
  const bundle = await fetch(`${origin}${asset}`, {
    headers: signedInHeaders,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(bundle.status, 200, "built dashboard bundle missing");
  assert.ok((await bundle.arrayBuffer()).byteLength > 1000);
  console.log("compiled server: health, docs/landing assets, skill ZIP and dashboard passed");
} else {
  throw new Error(`unknown container smoke mode: ${mode}`);
}
