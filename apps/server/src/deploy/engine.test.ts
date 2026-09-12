import { Buffer } from "node:buffer";
import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Manifest } from "@canvas-drop/shared/db";
import { sql } from "drizzle-orm";
import { zipSync } from "fflate";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blobKey, canvasBlobPrefix } from "../canvas/storage-keys.js";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { isUniqueViolation, RELEASE_READY_UNIQUE } from "../db/unique-violation.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";
import { memStorage } from "../storage/mem.js";
import { deployEngine } from "./engine.js";
import { PublicationConflictError } from "./errors.js";
import type { DeployEntry } from "./ingest.js";
import { fromZip } from "./ingest.js";
import type { WaitOptions } from "./publication.js";

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
    const drafts = draftsRepository(client);
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const cv = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "h" });
    const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
    return { engine, canvases, versions, drafts, storage, canvas: cv, ownerId: owner.id };
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

  it("a failed deploy cleans up its pending version row (no orphan, no burnt number)", async () => {
    const { engine, versions, canvas, ownerId } = await setup();
    // A zip-slip path fails validation AFTER the pending row + number were allocated.
    await expect(
      engine.deploy(
        canvas,
        "folder",
        folder({ "../escape.txt": "x", "index.html": "ok" }),
        ownerId,
      ),
    ).rejects.toThrow();
    // The pending row is gone — `pruneBeyond` would never have collected it (it only
    // prunes `ready` rows), so without inline cleanup it would linger and burn number 1.
    expect(await versions.listByCanvas(canvas.id)).toHaveLength(0);
    // And the number isn't wasted: the next good deploy is still version 1.
    const ok = await engine.deploy(canvas, "folder", folder({ "index.html": "ok" }), ownerId);
    expect(ok.version).toBe(1);
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
    const manifest = (v?.manifest ?? {}) as Record<string, { hash: string }>;
    expect(Object.keys(manifest).sort()).toEqual(["a/b.css", "app.js", "index.html"]);
    // Bytes live at the content-addressed blob key, not a per-version path.
    const indexHash = manifest["index.html"]?.hash as string;
    expect(await storage.get(blobKey(canvas.id, indexHash))).not.toBeNull();

    // a second deploy → version 2, pointer moves
    const r2 = await engine.deploy(canvas, "paste", folder({ "index.html": "y" }), ownerId);
    expect(r2.version).toBe(2);
    const after2 = await canvases.findById(canvas.id);
    expect(after2?.currentVersionId).not.toBe(after?.currentVersionId);
  });

  // --- post-deploy draft reconciliation: the editor must reflect a direct/API
  //     publish unless the owner has genuine unpublished edits to protect. ---
  it("a direct deploy with no existing draft seeds the draft to the published version", async () => {
    const { engine, canvases, drafts, canvas, ownerId } = await setup();
    await engine.deploy(canvas, "api", folder({ "index.html": "v1" }), ownerId);
    const after = await canvases.findById(canvas.id);
    const draft = await drafts.getByCanvas(canvas.id);
    expect(draft?.stale).toBe(false);
    expect(draft?.baseVersionId).toBe(after?.currentVersionId);
    expect(Object.keys((draft?.manifest ?? {}) as Manifest)).toEqual(["index.html"]);
  });

  it("an API deploy syncs an UNTOUCHED draft to the new version (no phantom stale/dirty)", async () => {
    // Repro of the reported bug: a draft that merely mirrors the previous version
    // (the editor's working copy, no real edits) must not be flagged stale by a
    // later API deploy — the editor should show what was just deployed.
    const { engine, canvases, versions, drafts, canvas, ownerId } = await setup();
    await engine.deploy(canvas, "folder", folder({ "old.html": "<h1>v1</h1>" }), ownerId);
    const v1Id = (await canvases.findById(canvas.id))?.currentVersionId as string;
    const v1Manifest = (await versions.findById(v1Id))?.manifest as Manifest;
    await drafts.resetToBase(canvas.id, v1Manifest, v1Id); // untouched working copy of v1

    await engine.deploy(canvas, "api", folder({ "new.html": "<h1>v2</h1>" }), ownerId);
    const v2Id = (await canvases.findById(canvas.id))?.currentVersionId as string;
    const draft = await drafts.getByCanvas(canvas.id);
    expect(draft?.stale).toBe(false); // no "a newer version was published"
    expect(draft?.baseVersionId).toBe(v2Id); // rebased onto the deploy
    expect(Object.keys((draft?.manifest ?? {}) as Manifest)).toEqual(["new.html"]); // shows v2
  });

  it("an API deploy PRESERVES a genuinely-edited draft and flags it stale", async () => {
    const { engine, canvases, versions, drafts, canvas, ownerId } = await setup();
    await engine.deploy(canvas, "folder", folder({ "old.html": "<h1>v1</h1>" }), ownerId);
    const v1Id = (await canvases.findById(canvas.id))?.currentVersionId as string;
    const v1Manifest = (await versions.findById(v1Id))?.manifest as Manifest;
    await drafts.resetToBase(canvas.id, v1Manifest, v1Id);
    // A real held edit: an extra file the owner added in the editor but didn't publish.
    await drafts.setManifest(canvas.id, {
      ...v1Manifest,
      "extra.html": { size: 3, hash: "deadbeef", mime: "text/html" },
    });

    await engine.deploy(canvas, "api", folder({ "new.html": "<h1>v2</h1>" }), ownerId);
    const draft = await drafts.getByCanvas(canvas.id);
    expect(draft?.stale).toBe(true); // editor warns "a newer version was published"
    // Held edits are preserved, not clobbered by the deploy.
    expect(Object.keys((draft?.manifest ?? {}) as Manifest).sort()).toEqual([
      "extra.html",
      "old.html",
    ]);
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

  it("warns about a rootless deploy (no index.html, several HTML files) but not a single-page one", async () => {
    const { engine, canvas, ownerId } = await setup();
    const noIndex = /no index\.html/i;

    // A lone HTML page (not named index.html) is served at the root → no warning.
    const single = await engine.deploy(
      canvas,
      "folder",
      folder({ "page.html": "<h1>hi</h1>", "style.css": "body{}" }),
      ownerId,
    );
    expect(single.warnings.some((w) => noIndex.test(w))).toBe(false);

    // Several HTML files and no index.html → the root 404s, so warn.
    const ambiguous = await engine.deploy(
      canvas,
      "folder",
      folder({ "a.html": "<h1>a</h1>", "b.html": "<h1>b</h1>" }),
      ownerId,
    );
    expect(ambiguous.warnings.some((w) => noIndex.test(w))).toBe(true);
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

  it("blob GC deleteMany failure is swallowed (deploy still returns cleanly)", async () => {
    const storage = memStorage();
    storage.deleteMany = async () => {
      throw new Error("storage deleteMany down");
    };
    const { engine, canvas, ownerId } = await setup(storage);
    for (let i = 0; i < 11; i++) {
      const r = await engine.deploy(canvas, "api", folder({ "index.html": `v${i}` }), ownerId);
      expect(r.version).toBe(i + 1); // deploy unaffected by GC-delete failures
    }
  });

  // --- CONTENT-ADDRESSED DEDUP (M5, AE1) ---
  it("a redeploy changing one file of twenty writes exactly one new blob (AE1)", async () => {
    const { engine, canvas, storage, ownerId } = await setup();
    const base: Record<string, string> = {};
    for (let i = 0; i < 20; i++) base[`f${i}.html`] = `<h1>file ${i}</h1>`;
    await engine.deploy(canvas, "folder", folder(base), ownerId);
    const afterFirst = (await storage.list(canvasBlobPrefix(canvas.id))).length;
    expect(afterFirst).toBe(20); // 20 distinct files → 20 blobs

    // Change exactly one file; the other 19 are byte-identical → reuse their blobs.
    const edited = { ...base, "f7.html": "<h1>file 7 — edited</h1>" };
    await engine.deploy(canvas, "folder", folder(edited), ownerId);
    const afterSecond = (await storage.list(canvasBlobPrefix(canvas.id))).length;
    expect(afterSecond).toBe(21); // exactly one NEW blob written (19 reused, old f7 still referenced by v1)
  });

  it("identical bytes at two paths in one deploy upload a single blob", async () => {
    const { engine, canvas, storage, ownerId } = await setup();
    await engine.deploy(
      canvas,
      "folder",
      folder({ "a.html": "<h1>same</h1>", "b.html": "<h1>same</h1>" }),
      ownerId,
    );
    expect((await storage.list(canvasBlobPrefix(canvas.id))).length).toBe(1);
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

  it("a deploy schedules a screenshot capture of the new version (plan 004 / U13)", async () => {
    client = await makeTestDb("sqlite");
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const cv = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "h" });
    const calls: Array<[string, string]> = [];
    const engine = deployEngine({
      config,
      canvases,
      versions,
      drafts,
      storage: memStorage(),
      log: silent,
      screenshots: { enqueue: async (canvas, v) => void calls.push([canvas.id, v]) },
    });
    await engine.deploy(cv, "api", folder({ "index.html": "v1" }), owner.id);
    const live = await canvases.findById(cv.id);
    expect(calls).toEqual([[cv.id, live?.currentVersionId]]);
  });
});

// ---------------------------------------------------------------------------
// Deployment coordination (plan 2026-09-12): release identity + publication token.
// ---------------------------------------------------------------------------
describe.each(DIALECTS)("deployEngine — deployment coordination [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  const R = "gh:acme/roadmap@3f9c2e1:prod";
  const S = "gh:acme/roadmap@77aa01b:prod";
  const HEX32 = /^[0-9a-f]{32}$/;

  interface Hooks {
    /** Called on the first storage put of a deploy — a window between pre-check and markReady. */
    onFirstPut?: () => Promise<void>;
    waitOptions?: WaitOptions;
    /** Replaces the silent logger (to assert on error-level cleanup reports). */
    log?: Logger;
  }

  async function setup(hooks: Hooks = {}) {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const cv = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "h" });
    const base = memStorage();
    let firstPut = true;
    const storage: StorageDriver = {
      ...base,
      async put(key, bytes) {
        if (firstPut && hooks.onFirstPut) {
          firstPut = false;
          await hooks.onFirstPut();
        }
        return base.put(key, bytes);
      },
    };
    const enqueue = vi.fn(async () => {});
    const markStale = vi.spyOn(drafts, "markStale");
    const resetToBase = vi.spyOn(drafts, "resetToBase");
    const engine = deployEngine({
      config,
      canvases,
      versions,
      drafts,
      storage,
      log: hooks.log ?? silent,
      screenshots: { enqueue } as never,
      waitOptions: hooks.waitOptions ?? { intervalMs: 5 },
    });
    /** A ready version with an optional release, made outside the engine (an editor publish / another publisher). */
    const readyVersion = async (releaseId?: string, ageMs = 0) => {
      const v = await versions.createPending({
        canvasId: cv.id,
        number: await versions.nextNumber(cv.id),
        createdBy: owner.id,
        source: "editor",
        releaseId,
      });
      await versions.markReady(v.id, { fileCount: 1, totalBytes: 1, manifest: {} });
      if (ageMs > 0) {
        const q = sql`update versions set created_at = ${Date.now() - ageMs} where id = ${v.id}`;
        if (client.dialect === "sqlite") client.db.run(q);
        else await client.db.execute(q);
      }
      return v;
    };
    const token = async () => (await canvases.findById(cv.id))?.publicationToken ?? "";
    const readyRows = async () =>
      (await versions.listByCanvas(cv.id)).filter((v) => v.status === "ready");
    return {
      engine,
      canvases,
      versions,
      drafts,
      canvas: cv,
      ownerId: owner.id,
      readyVersion,
      token,
      readyRows,
      spies: { enqueue, markStale, resetToBase },
    };
  }

  const deploy = (
    t: Awaited<ReturnType<typeof setup>>,
    files: Record<string, string>,
    coordination?: { releaseId?: string; expectedPublicationToken?: string },
  ) => t.engine.deploy(t.canvas, "api", folder(files), t.ownerId, { coordination });

  async function conflictOf(p: Promise<unknown>): Promise<PublicationConflictError> {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(PublicationConflictError);
      return err as PublicationConflictError;
    }
    throw new Error("expected a PublicationConflictError");
  }

  it("Covers AE1. the same release deployed twice: the second is already_current, one version exists, no second candidate", async () => {
    const t = await setup();
    const first = await deploy(t, { "index.html": "a" }, { releaseId: R });
    expect(first.outcome).toBe("published");
    expect(first.releaseId).toBe(R);
    expect(first.publicationToken).toMatch(HEX32);
    const createPending = vi.spyOn(t.versions, "createPending");
    const second = await deploy(t, { "index.html": "b" }, { releaseId: R });
    expect(second.outcome).toBe("already_current");
    expect(second.versionId).toBe(first.versionId);
    expect(second.version).toBe(first.version);
    expect(second.fileCount).toBe(1);
    expect(second.publicationToken).toBe(first.publicationToken);
    expect(second.warnings).toEqual([]);
    expect(createPending).not.toHaveBeenCalled();
    expect(await t.readyRows()).toHaveLength(1);
    // The live site still serves the FIRST deploy's bytes.
    expect((await t.versions.findById(first.versionId))?.manifest).toEqual(
      expect.objectContaining({ "index.html": expect.objectContaining({ size: 1 }) }),
    );
  });

  it("Covers AE2 / F2. two concurrent deploys of one release: exactly one ready version carries it, one result is already_current", async () => {
    const t = await setup();
    const [a, b] = await Promise.all([
      deploy(t, { "index.html": "a" }, { releaseId: R }),
      deploy(t, { "index.html": "b" }, { releaseId: R }),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["already_current", "published"]);
    expect(a.versionId).toBe(b.versionId);
    const ready = await t.readyRows();
    expect(ready).toHaveLength(1);
    expect(ready[0]?.releaseId).toBe(R);
    expect((await t.canvases.findById(t.canvas.id))?.currentVersionId).toBe(ready[0]?.id);
    // No pending leftovers from the loser.
    expect(await t.versions.listByCanvas(t.canvas.id)).toHaveLength(1);
  });

  it("Covers AE4 / F3. a token read before an editor publish is refused with PUBLICATION_CHANGED; the editor's version stays live", async () => {
    const t = await setup();
    const t1 = await t.token();
    const editors = await t.readyVersion(); // an editor publish lands in between
    await t.canvases.setCurrentVersion(t.canvas.id, editors.id);
    const t2 = await t.token();
    const err = await conflictOf(
      deploy(t, { "index.html": "x" }, { releaseId: R, expectedPublicationToken: t1 }),
    );
    expect(err.code).toBe("PUBLICATION_CHANGED");
    expect(err.current).toEqual({
      publicationToken: t2,
      versionId: editors.id,
      version: editors.number,
      releaseId: null,
    });
    expect((await t.canvases.findById(t.canvas.id))?.currentVersionId).toBe(editors.id);
    expect(await t.token()).toBe(t2);
    // The pre-check refused it before any candidate row existed.
    expect(await t.versions.listByCanvas(t.canvas.id)).toHaveLength(1);
  });

  it("the atomic activation refuses a token that changes between the pre-check and the swap; the candidate is removed", async () => {
    let t: Awaited<ReturnType<typeof setup>>;
    t = await setup({
      onFirstPut: async () => {
        const v = await t.readyVersion(); // someone publishes mid-ingest
        await t.canvases.setCurrentVersion(t.canvas.id, v.id);
      },
    });
    const t0 = await t.token();
    const err = await conflictOf(
      deploy(t, { "index.html": "x" }, { expectedPublicationToken: t0 }),
    );
    expect(err.code).toBe("PUBLICATION_CHANGED");
    expect(err.current.publicationToken).not.toBe(t0);
    const rows = await t.versions.listByCanvas(t.canvas.id);
    expect(rows).toHaveLength(1); // only the mid-ingest publish; our candidate is gone
    expect(rows[0]?.id).toBe(err.current.versionId);
    expect(t.spies.enqueue).not.toHaveBeenCalled();
  });

  it("Covers AE5 / F4. a release that exists only in history is RELEASE_NOT_CURRENT, naming that version; nothing is reactivated", async () => {
    const t = await setup();
    const first = await deploy(t, { "index.html": "r" }, { releaseId: R });
    const second = await deploy(t, { "index.html": "s" }, { releaseId: S });
    expect(await t.canvases.setCurrentVersionIfReady(t.canvas.id, first.versionId)).toBe(true); // rollback
    // Age the S holder out of the in-flight window: a rollback is history, not a race.
    const q = sql`update versions set created_at = ${Date.now() - 120_000} where id = ${second.versionId}`;
    if (client.dialect === "sqlite") client.db.run(q);
    else await client.db.execute(q);
    const err = await conflictOf(deploy(t, { "index.html": "s2" }, { releaseId: S }));
    expect(err.code).toBe("RELEASE_NOT_CURRENT");
    expect(err.release).toEqual({ versionId: second.versionId, version: second.version });
    expect(err.current.versionId).toBe(first.versionId);
    expect(err.current.releaseId).toBe(R);
    expect((await t.canvases.findById(t.canvas.id))?.currentVersionId).toBe(first.versionId);
    expect(await t.readyRows()).toHaveLength(2);
  });

  it("Covers AE7 / F5. first publication with the initial token succeeds and rotates it", async () => {
    const t = await setup();
    const t0 = t.canvas.publicationToken;
    expect(t0).toMatch(HEX32);
    const r = await deploy(
      t,
      { "index.html": "x" },
      { releaseId: R, expectedPublicationToken: t0 },
    );
    expect(r.outcome).toBe("published");
    expect(r.publicationToken).toMatch(HEX32);
    expect(r.publicationToken).not.toBe(t0);
    expect(await t.token()).toBe(r.publicationToken);
  });

  it("Covers AE8. a failed deploy with an expected token leaves the pointer and the token unchanged", async () => {
    const t = await setup();
    const live = await deploy(t, { "index.html": "ok" });
    await expect(
      deploy(
        t,
        { "../escape.txt": "x", "index.html": "y" },
        { expectedPublicationToken: live.publicationToken },
      ),
    ).rejects.toMatchObject({ code: "ZIP_SLIP_REJECTED" });
    expect(await t.token()).toBe(live.publicationToken);
    expect((await t.canvases.findById(t.canvas.id))?.currentVersionId).toBe(live.versionId);
    expect(await t.readyRows()).toHaveLength(1);
  });

  it("Covers AE9 / F7. a lost response: repeating the identical call (same release, same token) is already_current", async () => {
    const t = await setup();
    const t0 = await t.token();
    const first = await deploy(
      t,
      { "index.html": "x" },
      { releaseId: R, expectedPublicationToken: t0 },
    );
    expect(first.outcome).toBe("published");
    // The retry carries the OLD token, but the release check comes first (R9).
    const retry = await deploy(
      t,
      { "index.html": "x" },
      { releaseId: R, expectedPublicationToken: t0 },
    );
    expect(retry.outcome).toBe("already_current");
    expect(retry.versionId).toBe(first.versionId);
    expect(retry.publicationToken).toBe(first.publicationToken);
    expect(await t.readyRows()).toHaveLength(1);
  });

  it("Covers AE11. a deploy with no coordination fields publishes as today, with the additive fields present", async () => {
    const t = await setup();
    const r = await t.engine.deploy(t.canvas, "api", folder({ "index.html": "x" }), t.ownerId);
    expect(r.outcome).toBe("published");
    expect(r.releaseId).toBeNull();
    expect(r.publicationToken).toMatch(HEX32);
    expect(r.versionId).toBe((await t.canvases.findById(t.canvas.id))?.currentVersionId);
    expect(r.publicationToken).not.toBe(t.canvas.publicationToken);
  });

  it("an invalid releaseId is refused before any version row exists", async () => {
    const t = await setup();
    for (const bad of ["", "x".repeat(201), "a\nb"]) {
      await expect(deploy(t, { "index.html": "x" }, { releaseId: bad })).rejects.toMatchObject({
        code: "INVALID_RELEASE_ID",
      });
    }
    expect(await t.versions.listByCanvas(t.canvas.id)).toHaveLength(0);
    expect(await deploy(t, { "index.html": "x" }, { releaseId: "x".repeat(200) })).toMatchObject({
      outcome: "published",
    });
  });

  it("Covers R3 / R9 (KTD7). already_current and both conflicts trigger no screenshot and no draft write", async () => {
    const t = await setup();
    const live = await deploy(t, { "index.html": "x" }, { releaseId: R });
    expect(t.spies.enqueue).toHaveBeenCalledTimes(1);
    t.spies.enqueue.mockClear();
    t.spies.markStale.mockClear();
    t.spies.resetToBase.mockClear();

    await deploy(t, { "index.html": "y" }, { releaseId: R }); // already_current
    await conflictOf(
      deploy(t, { "index.html": "y" }, { expectedPublicationToken: "0".repeat(32) }),
    );
    await t.readyVersion(S, 120_000); // a historical holder for S
    await conflictOf(deploy(t, { "index.html": "y" }, { releaseId: S })); // RELEASE_NOT_CURRENT
    expect(t.spies.enqueue).not.toHaveBeenCalled();
    expect(t.spies.markStale).not.toHaveBeenCalled();
    expect(t.spies.resetToBase).not.toHaveBeenCalled();
    expect((await t.canvases.findById(t.canvas.id))?.currentVersionId).toBe(live.versionId);
  });

  it("KTD4 wait: a fresh holder that becomes current during the pre-check wait yields already_current", async () => {
    let t: Awaited<ReturnType<typeof setup>>;
    let sleeps = 0;
    t = await setup({
      waitOptions: {
        attempts: 5,
        sleep: async () => {
          sleeps++;
          if (sleeps === 2) {
            const holder = await t.versions.findReadyByRelease(t.canvas.id, R);
            if (holder) await t.canvases.setCurrentVersionIfReady(t.canvas.id, holder.id);
          }
        },
      },
    });
    const v1 = await t.readyVersion();
    await t.canvases.setCurrentVersion(t.canvas.id, v1.id);
    const holder = await t.readyVersion(R); // ready, fresh, not current: a winner mid-swap
    const r = await deploy(t, { "index.html": "x" }, { releaseId: R });
    expect(r.outcome).toBe("already_current");
    expect(r.versionId).toBe(holder.id);
    expect(sleeps).toBe(2);
    expect(await t.versions.listByCanvas(t.canvas.id)).toHaveLength(2); // no candidate was created
  });

  it("KTD4 wait: when the winner withdraws mid-wait, the loser retries markReady and publishes its own candidate", async () => {
    let t: Awaited<ReturnType<typeof setup>>;
    let holderId: string | undefined;
    t = await setup({
      // The rival becomes ready AFTER our pre-check passed (so our markReady collides).
      onFirstPut: async () => {
        holderId = (await t.readyVersion(R)).id;
      },
      waitOptions: {
        attempts: 5,
        sleep: async () => {
          // The rival's own activation failed (stale token) and it deleted its candidate.
          if (holderId) await t.versions.deleteReadyNonCurrentById(t.canvas.id, holderId);
        },
      },
    });
    const r = await deploy(t, { "index.html": "mine" }, { releaseId: R });
    expect(r.outcome).toBe("published");
    expect(r.releaseId).toBe(R);
    const ready = await t.readyRows();
    expect(ready).toHaveLength(1);
    expect(ready[0]?.id).toBe(r.versionId);
    expect((await t.canvases.findById(t.canvas.id))?.currentVersionId).toBe(r.versionId);
  });

  it("KTD4 wait: a holder outside the in-flight window is RELEASE_NOT_CURRENT at once, without sleeping", async () => {
    let slept = false;
    const t = await setup({
      waitOptions: {
        attempts: 5,
        sleep: async () => {
          slept = true;
        },
      },
    });
    const v1 = await t.readyVersion();
    await t.canvases.setCurrentVersion(t.canvas.id, v1.id);
    const old = await t.readyVersion(R, 120_000);
    const err = await conflictOf(deploy(t, { "index.html": "x" }, { releaseId: R }));
    expect(err.code).toBe("RELEASE_NOT_CURRENT");
    expect(err.release?.versionId).toBe(old.id);
    expect(slept).toBe(false);
  });

  it("KTD4 wait: a fresh holder that never lands times out as RELEASE_NOT_CURRENT naming it, and the loser's candidate is gone", async () => {
    let t: Awaited<ReturnType<typeof setup>>;
    let sleeps = 0;
    let holderId = "";
    t = await setup({
      onFirstPut: async () => {
        holderId = (await t.readyVersion(R)).id; // a rival that crashed between markReady and swap
      },
      waitOptions: {
        attempts: 3,
        sleep: async () => {
          sleeps++;
        },
      },
    });
    const err = await conflictOf(deploy(t, { "index.html": "x" }, { releaseId: R }));
    expect(err.code).toBe("RELEASE_NOT_CURRENT");
    expect(err.release?.versionId).toBe(holderId);
    expect(err.message).toContain("never activated");
    expect(sleeps).toBe(3);
    const rows = await t.versions.listByCanvas(t.canvas.id);
    expect(rows.map((v) => v.id)).toEqual([holderId]); // no pending candidate remains
    expect((await t.canvases.findById(t.canvas.id))?.currentVersionId).toBeNull();
  });

  it("a caller-owned activation hook still runs and the result carries the token it minted", async () => {
    const t = await setup();
    let hooked: string | undefined;
    const r = await t.engine.deploy(t.canvas, "api", folder({ "index.html": "x" }), t.ownerId, {
      activateVersion: async (versionId) => {
        hooked = versionId;
        await t.canvases.setCurrentVersion(t.canvas.id, versionId);
      },
    });
    expect(hooked).toBe(r.versionId);
    expect(r.publicationToken).toBe(await t.token());
    expect(r.publicationToken).not.toBe(t.canvas.publicationToken);
  });

  it("a transient failure removing the lost candidate is retried; the conflict still surfaces and no orphan remains", async () => {
    let t: Awaited<ReturnType<typeof setup>>;
    t = await setup({
      onFirstPut: async () => {
        const v = await t.readyVersion(); // someone publishes mid-ingest
        await t.canvases.setCurrentVersion(t.canvas.id, v.id);
      },
      waitOptions: { intervalMs: 5, sleep: async () => {} },
    });
    const original = t.versions.deleteReadyNonCurrentById.bind(t.versions);
    const cleanup = vi
      .spyOn(t.versions, "deleteReadyNonCurrentById")
      .mockRejectedValueOnce(new Error("db blip"))
      .mockRejectedValueOnce(new Error("db blip"))
      .mockImplementation(original);
    const t0 = await t.token();
    const err = await conflictOf(
      deploy(t, { "index.html": "x" }, { expectedPublicationToken: t0 }),
    );
    expect(err.code).toBe("PUBLICATION_CHANGED");
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(await t.readyRows()).toHaveLength(1); // only the mid-ingest publish; our candidate is gone
  });

  it("when removing the lost candidate keeps failing, the conflict is still raised and the orphan is reported at error level", async () => {
    const log = silent.child({});
    const errorLog = vi.spyOn(log, "error");
    let t: Awaited<ReturnType<typeof setup>>;
    t = await setup({
      onFirstPut: async () => {
        const v = await t.readyVersion();
        await t.canvases.setCurrentVersion(t.canvas.id, v.id);
      },
      waitOptions: { intervalMs: 5, sleep: async () => {} },
      log,
    });
    const cleanup = vi
      .spyOn(t.versions, "deleteReadyNonCurrentById")
      .mockRejectedValue(new Error("db down"));
    const t0 = await t.token();
    const err = await conflictOf(
      deploy(t, { "index.html": "x" }, { expectedPublicationToken: t0 }),
    );
    expect(err.code).toBe("PUBLICATION_CHANGED");
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const orphan = (await t.readyRows()).find((v) => v.id !== err.current.versionId);
    expect(orphan).toBeDefined(); // the ready orphan remains, named in the log for manual removal
    const logged = errorLog.mock.calls[0]?.[0] as { versionId?: string; attempts?: number };
    expect(logged.versionId).toBe(orphan?.id);
    expect(logged.attempts).toBe(3);
  });

  it("a unique violation that persists while the holder reads absent surfaces the raw error after the retry cap; the candidate is discarded", async () => {
    let t: Awaited<ReturnType<typeof setup>>;
    let holderId = "";
    t = await setup({
      onFirstPut: async () => {
        holderId = (await t.readyVersion(R)).id; // a rival lands after our pre-check
      },
      waitOptions: { attempts: 1, sleep: async () => {} },
    });
    // The classifier never sees the holder (as if it had withdrawn), so every retry collides again.
    vi.spyOn(t.versions, "findReadyByRelease").mockResolvedValue(null);
    const markReady = vi.spyOn(t.versions, "markReady");
    let caught: unknown;
    try {
      await deploy(t, { "index.html": "x" }, { releaseId: R });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(PublicationConflictError);
    expect(isUniqueViolation(caught, RELEASE_READY_UNIQUE)).toBe(true);
    // The rival's own markReady (from readyVersion) aside: our first attempt plus three retries.
    expect(markReady.mock.calls.filter(([id]) => id !== holderId)).toHaveLength(4);
    const rows = await t.versions.listByCanvas(t.canvas.id);
    expect(rows.map((v) => v.id)).toEqual([holderId]); // no pending candidate remains
    expect((await t.canvases.findById(t.canvas.id))?.currentVersionId).toBeNull();
  });

  it("a same-release rival whose ingest outlived the in-flight window is still waited for at markReady, and its landing is already_current", async () => {
    let t: Awaited<ReturnType<typeof setup>>;
    let holderId = "";
    t = await setup({
      onFirstPut: async () => {
        // The rival's pending row is older than the window (slow storage writes) but it
        // only became ready after our pre-check passed.
        holderId = (await t.readyVersion(R, 120_000)).id;
      },
      waitOptions: {
        attempts: 5,
        sleep: async () => {
          // The rival's swap lands during our wait.
          await t.canvases.setCurrentVersionIfReady(t.canvas.id, holderId);
        },
      },
    });
    const r = await deploy(t, { "index.html": "mine" }, { releaseId: R });
    expect(r.outcome).toBe("already_current");
    expect(r.versionId).toBe(holderId);
    expect(await t.readyRows()).toHaveLength(1); // our candidate never became ready
  });

  it("a caller-owned activation hook combined with an expected token is refused before anything is published", async () => {
    const t = await setup();
    const t0 = await t.token();
    await expect(
      t.engine.deploy(t.canvas, "api", folder({ "index.html": "x" }), t.ownerId, {
        activateVersion: async () => {
          throw new Error("hook must not run");
        },
        coordination: { expectedPublicationToken: t0 },
      }),
    ).rejects.toThrow(/caller-owned activateVersion hook/);
    expect(await t.readyRows()).toHaveLength(0);
    expect((await t.canvases.findById(t.canvas.id))?.currentVersionId).toBeNull();
    expect(await t.token()).toBe(t0);
  });
});
