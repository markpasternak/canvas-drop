import { Buffer } from "node:buffer";
import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
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
import { deployEngine } from "./engine.js";
import type { DeployEntry } from "./ingest.js";
import { fromZip } from "./ingest.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const silent = pino({ level: "silent" });
const enc = (s: string) => new TextEncoder().encode(s);

/** In-memory storage with an optional fail-on-Nth-put hook for the atomicity test. */
function memStorage(failOnPut?: number): StorageDriver {
  const store = new Map<string, Uint8Array>();
  let puts = 0;
  return {
    async put(key, bytes) {
      puts++;
      if (failOnPut && puts === failOnPut) throw new Error("storage down");
      store.set(key, bytes);
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async delete(key) {
      store.delete(key);
    },
    async exists(key) {
      return store.has(key);
    },
    async list(prefix) {
      return [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

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
