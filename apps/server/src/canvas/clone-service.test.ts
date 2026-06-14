import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Canvas, Manifest } from "@canvas-drop/shared/db";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../audit/audit-log.js";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import type { DeployEntry } from "../deploy/ingest.js";
import { draftService } from "../draft/service.js";
import { memStorage } from "../storage/mem.js";
import { cloneService } from "./clone-service.js";
import { blobKey, canvasBlobPrefix } from "./storage-keys.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const silent = pino({ level: "silent" });
const enc = (s: string) => new TextEncoder().encode(s);

async function* folder(files: Record<string, string>): AsyncGenerator<DeployEntry> {
  for (const [path, body] of Object.entries(files)) yield { path, bytes: enc(body) };
}

describe.each(DIALECTS)("cloneService (%s)", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function setup() {
    client = await makeTestDb(dialect);
    const storage = memStorage();
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const audit = createAuditLog(auditRepository(client), silent);
    const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
    const draftSvc = draftService({
      config,
      canvases,
      versions,
      drafts,
      storage,
      audit,
      log: silent,
    });
    const clone = cloneService({ canvases, versions, drafts, storage });

    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const cloner = await users.upsert({
      providerSub: "c",
      email: "c@e.com",
      name: "C",
      isAdmin: false,
    });
    const reload = async (id: string) => (await canvases.findById(id)) as Canvas;
    return { storage, canvases, versions, drafts, engine, draftSvc, clone, owner, cloner, reload };
  }

  it("clones a published canvas: new owned canvas, draft = published manifest, blobs copied", async () => {
    const { storage, canvases, drafts, engine, clone, owner, cloner, reload } = await setup();
    const src = await canvases.create({
      ownerId: owner.id,
      slug: "src",
      apiKeyHash: "k",
      title: "My Site",
    });
    await engine.deploy(
      src,
      "folder",
      folder({ "index.html": "<h1>v1</h1>", "app.js": "1" }),
      owner.id,
    );
    const published = await reload(src.id);
    const srcVersion = await versionsRepositoryManifest(
      client,
      published.currentVersionId as string,
    );

    const { canvas } = await clone.clone(published, cloner.id);

    // New, owned, distinct identity with its own fresh (un-returned) deploy key.
    expect(canvas.id).not.toBe(src.id);
    expect(canvas.slug).not.toBe(src.slug);
    expect(canvas.ownerId).toBe(cloner.id);
    expect(canvas.apiKeyHash).not.toBe(src.apiKeyHash);
    expect(canvas.title).toBe("Copy of My Site");

    // Clone-to-draft: unpublished, no history.
    expect(canvas.currentVersionId).toBeNull();
    expect(canvas.clonedFromCanvasId).toBe(src.id);

    // Draft manifest equals the source's PUBLISHED manifest.
    const draft = await drafts.getByCanvas(canvas.id);
    expect(draft?.manifest).toEqual(srcVersion);

    // Every referenced blob exists under the clone's namespace; source untouched.
    for (const entry of Object.values(srcVersion)) {
      expect(await storage.get(blobKey(canvas.id, entry.hash))).not.toBeNull();
      expect(await storage.get(blobKey(src.id, entry.hash))).not.toBeNull();
    }
  });

  it("falls back to the source's draft when the source was never published", async () => {
    const { canvases, drafts, draftSvc, clone, owner, cloner } = await setup();
    const src = await canvases.create({ ownerId: owner.id, slug: "src", apiKeyHash: "k" });
    await draftSvc.writeFile(src, "index.html", enc("<h1>draft only</h1>"));
    const srcDraft = await drafts.getByCanvas(src.id);

    const { canvas } = await clone.clone(await reloadCanvas(canvases, src.id), cloner.id);

    const cloneDraft = await drafts.getByCanvas(canvas.id);
    expect(cloneDraft?.manifest).toEqual(srcDraft?.manifest);
    expect(Object.keys(cloneDraft?.manifest as Manifest)).toEqual(["index.html"]);
  });

  it("dedups blobs by hash: two paths sharing content copy one blob", async () => {
    const { storage, canvases, engine, clone, owner, cloner, reload } = await setup();
    const src = await canvases.create({ ownerId: owner.id, slug: "src", apiKeyHash: "k" });
    // a.html and b.html have identical bytes → identical hash → one blob.
    await engine.deploy(src, "folder", folder({ "a.html": "same", "b.html": "same" }), owner.id);
    const published = await reload(src.id);

    const { canvas } = await clone.clone(published, cloner.id);
    const blobs = await storage.list(canvasBlobPrefix(canvas.id));
    expect(blobs.length).toBe(1);
  });

  it("resets sharing/gallery state regardless of the source's state", async () => {
    const { canvases, engine, clone, owner, cloner, reload } = await setup();
    const src = await canvases.create({ ownerId: owner.id, slug: "src", apiKeyHash: "k" });
    await engine.deploy(src, "folder", folder({ "index.html": "<h1>v1</h1>" }), owner.id);
    // Source is shared + listed.
    await canvases.updateSettings(src.id, { shared: true, galleryListed: true });

    const { canvas } = await clone.clone(await reload(src.id), cloner.id);
    expect(canvas.shared).toBe(false);
    expect(canvas.galleryListed).toBe(false);
    expect(canvas.galleryTemplatable).toBe(false);
    expect(canvas.galleryPublishedAt).toBeNull();
  });

  it("carries the source password (hash + version) for a protected source; null otherwise", async () => {
    const { canvases, engine, clone, owner, cloner, reload } = await setup();
    // Protected source.
    const prot = await canvases.create({ ownerId: owner.id, slug: "p", apiKeyHash: "kp" });
    await engine.deploy(prot, "folder", folder({ "index.html": "x" }), owner.id);
    await canvases.setPassword(prot.id, "the-hash");
    const protReloaded = await reload(prot.id);

    const { canvas: protClone } = await clone.clone(protReloaded, cloner.id);
    expect(protClone.passwordHash).toBe("the-hash");
    expect(protClone.passwordVersion).toBe(protReloaded.passwordVersion);

    // Unprotected source → no password on the clone.
    const open = await canvases.create({ ownerId: owner.id, slug: "o2", apiKeyHash: "ko" });
    await engine.deploy(open, "folder", folder({ "index.html": "x" }), owner.id);
    const { canvas: openClone } = await clone.clone(await reload(open.id), cloner.id);
    expect(openClone.passwordHash).toBeNull();
    expect(openClone.passwordVersion).toBe(0);
  });

  it("clone blobs survive deletion of the source's blobs (per-canvas isolation)", async () => {
    const { storage, canvases, engine, clone, owner, cloner, reload } = await setup();
    const src = await canvases.create({ ownerId: owner.id, slug: "src", apiKeyHash: "k" });
    await engine.deploy(src, "folder", folder({ "index.html": "<h1>v1</h1>" }), owner.id);
    const { canvas } = await clone.clone(await reload(src.id), cloner.id);

    // Purge the source's blobs entirely.
    await storage.deleteMany(await storage.list(canvasBlobPrefix(src.id)));
    expect((await storage.list(canvasBlobPrefix(src.id))).length).toBe(0);
    // The clone's blobs remain.
    expect((await storage.list(canvasBlobPrefix(canvas.id))).length).toBeGreaterThan(0);
  });

  it("copies every blob when the file count exceeds the parallel-copy batch size", async () => {
    const { storage, canvases, drafts, engine, clone, owner, cloner, reload } = await setup();
    const src = await canvases.create({ ownerId: owner.id, slug: "src", apiKeyHash: "k" });
    // 20 distinct files > COPY_CONCURRENCY (8) → the batching loop runs several iterations.
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.html`] = `<h1>${i}</h1>`;
    await engine.deploy(src, "folder", folder(files), owner.id);

    const { canvas } = await clone.clone(await reload(src.id), cloner.id);
    expect(Object.keys((await drafts.getByCanvas(canvas.id))?.manifest as Manifest)).toHaveLength(
      20,
    );
    expect((await storage.list(canvasBlobPrefix(canvas.id))).length).toBe(20);
  });

  it("rolls back the orphan canvas when a blob copy fails mid-clone", async () => {
    const { storage, canvases, engine, clone, owner, cloner, reload } = await setup();
    const src = await canvases.create({ ownerId: owner.id, slug: "src", apiKeyHash: "k" });
    await engine.deploy(src, "folder", folder({ "a.html": "AAA", "b.html": "BBB" }), owner.id);
    const published = await reload(src.id);
    const manifest = await versionsRepositoryManifest(client, published.currentVersionId as string);
    // Remove one source blob so the clone's copy loop throws not_found mid-way.
    const victimHash = Object.values(manifest)[0]?.hash as string;
    await storage.deleteMany([blobKey(src.id, victimHash)]);

    // Rejects with the ORIGINAL typed copy error (not a rollback/list error).
    await expect(clone.clone(published, cloner.id)).rejects.toMatchObject({ code: "not_found" });

    // No surviving active orphan canvas, and no leftover clone blobs.
    expect(await canvases.listByOwner(cloner.id)).toEqual([]);
    const cloneBlobs = (await storage.list("canvases/")).filter(
      (k) => !k.startsWith(canvasBlobPrefix(src.id)),
    );
    expect(cloneBlobs).toEqual([]);
  });

  it("clones a never-published, never-edited canvas into an empty draft", async () => {
    const { storage, canvases, drafts, clone, owner, cloner } = await setup();
    const src = await canvases.create({ ownerId: owner.id, slug: "src", apiKeyHash: "k" });

    const { canvas } = await clone.clone(await reloadCanvas(canvases, src.id), cloner.id);
    expect(canvas.ownerId).toBe(cloner.id);
    expect((await drafts.getByCanvas(canvas.id))?.manifest).toEqual({});
    expect((await storage.list(canvasBlobPrefix(canvas.id))).length).toBe(0);
  });

  it("titles an untitled source's clone 'Copy of Untitled canvas' and carries the description", async () => {
    const { canvases, engine, clone, owner, cloner, reload } = await setup();
    // create() defaults title to "" and we set a description.
    const src = await canvases.create({
      ownerId: owner.id,
      slug: "src",
      apiKeyHash: "k",
      description: "the original blurb",
    });
    await engine.deploy(src, "folder", folder({ "index.html": "x" }), owner.id);

    const { canvas } = await clone.clone(await reload(src.id), cloner.id);
    expect(canvas.title).toBe("Copy of Untitled canvas");
    expect(canvas.description).toBe("the original blurb");
  });
});

/** Read a published version's manifest directly (helper to compare against). */
async function versionsRepositoryManifest(client: DbClient, versionId: string): Promise<Manifest> {
  const versions = versionsRepository(client);
  const v = await versions.findById(versionId);
  return (v?.manifest ?? {}) as Manifest;
}

async function reloadCanvas(
  canvases: ReturnType<typeof canvasesRepository>,
  id: string,
): Promise<Canvas> {
  return (await canvases.findById(id)) as Canvas;
}
