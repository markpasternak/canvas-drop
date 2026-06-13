import { Buffer } from "node:buffer";
import { type Config, loadConfig } from "@canvas-drop/shared";
import { zipSync } from "fflate";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { versionStorageKey } from "../canvas/storage-keys.js";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { makeTestDb } from "../db/testing.js";
import type { StorageDriver } from "../storage/driver.js";
import { memStorage } from "../storage/mem.js";
import { deployEngine } from "./engine.js";
import type { DeployEntry } from "./ingest.js";
import { fromZip } from "./ingest.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const silent = pino({ level: "silent" });
const enc = (s: string) => new TextEncoder().encode(s);

async function* folder(files: Record<string, string>): AsyncGenerator<DeployEntry> {
  for (const [path, body] of Object.entries(files)) yield { path, bytes: enc(body) };
}

describe("deployEngine", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function setup(storage: StorageDriver = memStorage()) {
    client = await makeTestDb("sqlite");
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const cv = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "h" });
    const engine = deployEngine({ config, canvases, versions, storage, log: silent });
    return { engine, canvases, versions, storage, canvas: cv, ownerId: owner.id };
  }

  // --- ATOMICITY FIRST (execution note) ---
  it("a storage failure mid-deploy leaves current_version_id unchanged and no ready version", async () => {
    const { engine, canvases, versions, canvas, ownerId } = await setup(memStorage(2)); // fail on 2nd put
    await expect(
      engine.deploy(canvas, "folder", folder({ "index.html": "a", "app.js": "b" }), ownerId),
    ).rejects.toThrow();
    const after = await canvases.findById(canvas.id);
    expect(after?.currentVersionId).toBeNull(); // pointer untouched
    const history = await versions.listByCanvas(canvas.id);
    expect(history.every((v) => v.status !== "ready")).toBe(true); // nothing went ready
  });

  it("happy path: a 3-file folder deploys as version 1 with a full manifest", async () => {
    const { engine, canvases, versions, storage, canvas, ownerId } = await setup();
    const result = await engine.deploy(
      canvas,
      "folder",
      folder({ "index.html": "<h1>x</h1>", "app.js": "1", "a/b.css": "c" }),
      ownerId,
    );
    expect(result.version).toBe(1);
    expect(result.fileCount).toBe(3);
    const after = await canvases.findById(canvas.id);
    expect(after?.currentVersionId).toBeTruthy();
    const v = await versions.findById(after?.currentVersionId as string);
    expect(v?.status).toBe("ready");
    expect(Object.keys(v?.manifest ?? {}).sort()).toEqual(["a/b.css", "app.js", "index.html"]);
    expect(await storage.get(versionStorageKey(v?.id as string, "index.html"))).not.toBeNull();

    // a second deploy → version 2, pointer moves
    const r2 = await engine.deploy(canvas, "paste", folder({ "index.html": "y" }), ownerId);
    expect(r2.version).toBe(2);
    const after2 = await canvases.findById(canvas.id);
    expect(after2?.currentVersionId).not.toBe(after?.currentVersionId);
  });

  it("strips dotfiles and warns on blocked executables (served as text)", async () => {
    const { engine, canvas, versions, canvases, ownerId } = await setup();
    const result = await engine.deploy(
      canvas,
      "folder",
      folder({ "index.html": "x", ".env": "SECRET=1", "tool.php": "<?php ?>" }),
      ownerId,
    );
    expect(result.fileCount).toBe(2); // .env stripped
    expect(result.warnings.some((w) => w.includes("tool.php"))).toBe(true);
    const v = await versions.findById(
      (await canvases.findById(canvas.id))?.currentVersionId as string,
    );
    expect(Object.keys(v?.manifest ?? {})).not.toContain(".env");
  });

  it("rejects an empty deploy with EMPTY_DEPLOY (no version written)", async () => {
    const { engine, canvas, versions, ownerId } = await setup();
    await expect(engine.deploy(canvas, "folder", folder({}), ownerId)).rejects.toMatchObject({
      code: "EMPTY_DEPLOY",
    });
    expect((await versions.listByCanvas(canvas.id)).every((v) => v.status !== "ready")).toBe(true);
  });

  it("rejects a file over 25 MB with FILE_TOO_LARGE", async () => {
    const { engine, canvas, ownerId } = await setup();
    async function* big(): AsyncGenerator<DeployEntry> {
      yield { path: "big.bin", bytes: new Uint8Array(26 * 1024 * 1024) };
    }
    await expect(engine.deploy(canvas, "folder", big(), ownerId)).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });

  it("rejects a zip-slip entry with ZIP_SLIP_REJECTED and writes no version", async () => {
    const { engine, canvas, versions, ownerId } = await setup();
    const zip = Buffer.from(zipSync({ "../escape.txt": enc("evil"), "index.html": enc("ok") }));
    await expect(engine.deploy(canvas, "zip", fromZip(zip), ownerId)).rejects.toMatchObject({
      code: "ZIP_SLIP_REJECTED",
    });
    expect((await versions.listByCanvas(canvas.id)).every((v) => v.status !== "ready")).toBe(true);
  });

  it("deploys a valid ZIP end-to-end", async () => {
    const { engine, canvas, ownerId } = await setup();
    const zip = Buffer.from(zipSync({ "index.html": enc("<h1>zip</h1>"), "app.js": enc("1") }));
    const result = await engine.deploy(canvas, "zip", fromZip(zip), ownerId);
    expect(result.fileCount).toBe(2);
  });

  it("rejects >100 MB total with CANVAS_TOO_LARGE and >2000 files with TOO_MANY_FILES", async () => {
    const { engine, canvas, ownerId } = await setup();
    // 5 files of 25 MB each = 125 MB > 100 MB cap
    async function* tooBig(): AsyncGenerator<DeployEntry> {
      for (let i = 0; i < 5; i++) {
        yield { path: `f${i}.bin`, bytes: new Uint8Array(25 * 1024 * 1024 - 1) };
      }
    }
    await expect(engine.deploy(canvas, "folder", tooBig(), ownerId)).rejects.toMatchObject({
      code: "CANVAS_TOO_LARGE",
    });

    const { engine: e2, canvas: c2, ownerId: o2 } = await setup();
    async function* tooMany(): AsyncGenerator<DeployEntry> {
      for (let i = 0; i < 2001; i++) yield { path: `f${i}.txt`, bytes: enc("x") };
    }
    await expect(e2.deploy(c2, "folder", tooMany(), o2)).rejects.toMatchObject({
      code: "TOO_MANY_FILES",
    });
  });

  it("warns when a text file appears to contain a canvas API key (§12.1.2 lint)", async () => {
    const { engine, canvas, ownerId } = await setup();
    const key = `cd_${"A".repeat(50)}`;
    const result = await engine.deploy(
      canvas,
      "folder",
      folder({ "index.html": "ok", "config.js": `const KEY="${key}"` }),
      ownerId,
    );
    expect(result.warnings.some((w) => w.includes("config.js") && /API key/i.test(w))).toBe(true);
  });

  it("concurrent deploys to one canvas both succeed with distinct version numbers (no 500)", async () => {
    const { engine, canvas, versions, ownerId } = await setup();
    const [r1, r2] = await Promise.all([
      engine.deploy(canvas, "api", folder({ "index.html": "a" }), ownerId),
      engine.deploy(canvas, "api", folder({ "index.html": "b" }), ownerId),
    ]);
    expect(new Set([r1.version, r2.version])).toEqual(new Set([1, 2])); // distinct, contiguous
    const ready = (await versions.listByCanvas(canvas.id)).filter((v) => v.status === "ready");
    expect(ready.length).toBe(2);
  });

  it("prune never drops the version the live pointer points to, even if it is old (re-read)", async () => {
    const { engine, canvases, versions, canvas, ownerId } = await setup();
    // Create 12 ready versions directly (no engine auto-prune in the loop).
    const ids: string[] = [];
    for (let n = 1; n <= 12; n++) {
      const v = await versions.createPending({
        canvasId: canvas.id,
        number: n,
        createdBy: ownerId,
        source: "api",
      });
      await versions.markReady(v.id, {
        fileCount: 1,
        totalBytes: 1,
        manifest: { "index.html": { size: 1, hash: `h${n}`, mime: "text/html" } },
      });
      ids.push(v.id);
    }
    // Live pointer is the OLDEST version (as if a rollback to v1 just landed).
    await canvases.setCurrentVersion(canvas.id, ids[0] as string);
    await engine.prune(canvas.id); // re-reads the pointer; must keep v1, drop only v2
    expect(await versions.findById(ids[0] as string)).not.toBeNull(); // current (old) survives
    expect(await versions.findById(ids[1] as string)).toBeNull(); // v2 pruned (oldest non-current)
  });

  it("prune storage-delete failure is swallowed (deploy still returns cleanly)", async () => {
    const storage = memStorage();
    storage.delete = async () => {
      throw new Error("storage delete down");
    };
    const { engine, canvas, ownerId } = await setup(storage);
    for (let i = 0; i < 11; i++) {
      const r = await engine.deploy(canvas, "api", folder({ "index.html": `v${i}` }), ownerId);
      expect(r.version).toBe(i + 1); // deploy unaffected by prune-delete failures
    }
  });

  it("prunes ready versions beyond the newest 10 (async), keeping the current", async () => {
    const { engine, canvas, versions, ownerId } = await setup();
    for (let i = 0; i < 11; i++) {
      await engine.deploy(canvas, "api", folder({ "index.html": `v${i}` }), ownerId);
    }
    // prune is fire-and-forget; give it a tick
    await new Promise((r) => setTimeout(r, 50));
    const history = await versions.listByCanvas(canvas.id);
    expect(history.length).toBe(10);
    expect(history[0]?.number).toBe(11); // newest kept and current
  });
});
