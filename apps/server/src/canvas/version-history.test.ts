import { loadConfig } from "@canvas-drop/shared";
import type { Manifest } from "@canvas-drop/shared/db";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditLog } from "../audit/audit-log.js";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { uploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import type { Logger } from "../log/logger.js";
import { memStorage } from "../storage/mem.js";
import { blobKey } from "./storage-keys.js";
import { versionHistoryService } from "./version-history.js";

const enc = (value: string) => new TextEncoder().encode(value);
const manifest = (entries: Record<string, string>): Manifest =>
  Object.fromEntries(
    Object.entries(entries).map(([path, hash]) => [
      path,
      { size: hash.length, hash, mime: "text/plain" },
    ]),
  );

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

describe.each(DIALECTS)("versionHistoryService [%s]", (dialect) => {
  let client: DbClient;

  afterEach(async () => {
    await client?.close();
  });

  async function setup() {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const uploadSessions = uploadSessionsRepository(client);
    const storage = memStorage();
    const owner = await users.upsert({
      providerSub: "owner",
      email: "owner@example.com",
      name: "Owner",
      isAdmin: false,
    });
    const canvas = await canvases.create({
      ownerId: owner.id,
      slug: "history-test",
      apiKeyHash: `key-${dialect}`,
    });
    const engine = deployEngine({
      config,
      canvases,
      versions,
      drafts,
      uploadSessions,
      storage,
      log,
    });
    const recordAudit = vi.fn();
    const audit = { recordAudit, record() {}, async flush() {} } as AuditLog;
    const service = versionHistoryService({
      versions,
      drafts,
      uploadSessions,
      storage,
      engine,
      audit,
    });
    return {
      owner,
      canvas,
      canvases,
      versions,
      drafts,
      uploadSessions,
      storage,
      recordAudit,
      service,
      engine,
    };
  }

  async function ready(
    versions: ReturnType<typeof versionsRepository>,
    canvasId: string,
    ownerId: string,
    number: number,
    files: Manifest,
  ) {
    const pending = await versions.createPending({
      canvasId,
      number,
      createdBy: ownerId,
      source: "api",
    });
    return versions.markReady(pending.id, {
      fileCount: Object.keys(files).length,
      totalBytes: Object.values(files).reduce((sum, entry) => sum + entry.size, 0),
      manifest: files,
    });
  }

  it("builds a complete ZIP and fails rather than returning a partial archive", async () => {
    const { owner, canvas, versions, storage, service } = await setup();
    const files = manifest({ "index.html": "index-hash", "assets/app.js": "js-hash" });
    await ready(versions, canvas.id, owner.id, 1, files);
    await storage.put(blobKey(canvas.id, "index-hash"), enc("<h1>Hello</h1>"));
    await storage.put(blobKey(canvas.id, "js-hash"), enc("console.log('ok')"));

    const archive = await service.archive(canvas, 1);
    const entries = unzipSync(archive.bytes);
    expect(archive.filename).toBe("history-test-v1.zip");
    expect(new TextDecoder().decode(entries["index.html"])).toBe("<h1>Hello</h1>");
    expect(new TextDecoder().decode(entries["assets/app.js"])).toBe("console.log('ok')");

    await storage.delete(blobKey(canvas.id, "js-hash"));
    await expect(service.archive(canvas, 1)).rejects.toMatchObject({
      code: "BLOB_MISSING",
    });
  });

  it("bounds concurrent blob reads while exporting a many-file version", async () => {
    const { owner, canvas, versions, storage, service } = await setup();
    const hashes = Array.from({ length: 12 }, (_, i) => `hash-${i}`);
    const files = manifest(Object.fromEntries(hashes.map((hash, i) => [`file-${i}.txt`, hash])));
    await ready(versions, canvas.id, owner.id, 1, files);
    for (const hash of hashes) await storage.put(blobKey(canvas.id, hash), enc(hash));

    const get = storage.get.bind(storage);
    let inFlight = 0;
    let peak = 0;
    storage.get = async (key) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try {
        return await get(key);
      } finally {
        inFlight--;
      }
    };

    await service.archive(canvas, 1);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("deletes one historical row, audits it, and preserves shared and draft blobs", async () => {
    const { owner, canvas, canvases, versions, drafts, storage, recordAudit, service } =
      await setup();
    const old = await ready(
      versions,
      canvas.id,
      owner.id,
      1,
      manifest({ "old.txt": "old-only", "shared.txt": "shared" }),
    );
    const current = await ready(
      versions,
      canvas.id,
      owner.id,
      2,
      manifest({ "shared.txt": "shared" }),
    );
    await canvases.setCurrentVersion(canvas.id, current.id);
    await drafts.create({
      canvasId: canvas.id,
      manifest: manifest({ "draft.txt": "draft-only" }),
      baseVersionId: old.id,
    });
    for (const hash of ["old-only", "shared", "draft-only"]) {
      await storage.put(blobKey(canvas.id, hash), enc(hash));
    }

    const result = await service.deleteHistorical(canvas.id, 1, owner.id);

    expect(result).toMatchObject({ kind: "deleted", version: { number: 1 } });
    expect(await versions.findById(old.id)).toBeNull();
    expect(await storage.get(blobKey(canvas.id, "old-only"))).toBeNull();
    expect(await storage.get(blobKey(canvas.id, "shared"))).not.toBeNull();
    expect(await storage.get(blobKey(canvas.id, "draft-only"))).not.toBeNull();
    expect(recordAudit).toHaveBeenCalledWith({
      action: "version_delete",
      actorId: owner.id,
      targetId: canvas.id,
      meta: { version: 1 },
    });
  });

  it("protects the current version and distinguishes missing history", async () => {
    const { owner, canvas, canvases, versions, service } = await setup();
    const current = await ready(versions, canvas.id, owner.id, 1, manifest({ "x.txt": "x" }));
    await canvases.setCurrentVersion(canvas.id, current.id);

    expect(await service.deleteHistorical(canvas.id, 1, owner.id)).toEqual({ kind: "current" });
    expect(await service.deleteHistorical(canvas.id, 99, owner.id)).toEqual({ kind: "not_found" });
  });

  it("previews a selection as a union of unique blobs, protecting history and the draft", async () => {
    const { owner, canvas, canvases, versions, drafts, service } = await setup();
    await ready(versions, canvas.id, owner.id, 1, manifest({ a: "unique", b: "both", c: "draft" }));
    await ready(versions, canvas.id, owner.id, 2, manifest({ a: "both", b: "retained" }));
    const live = await ready(versions, canvas.id, owner.id, 3, manifest({ a: "retained" }));
    await canvases.setCurrentVersion(canvas.id, live.id);
    await drafts.create({
      canvasId: canvas.id,
      manifest: manifest({ a: "draft" }),
      baseVersionId: live.id,
    });
    const cv = { ...canvas, currentVersionId: live.id };
    expect(await service.previewPrune(cv, [1, 2, 2, 3, 99])).toMatchObject({
      versions: [1, 2],
      estimatedReclaimableBytes: "unique".length + "both".length,
      skipped: [
        { version: 3, reason: "current" },
        { version: 99, reason: "not_found" },
      ],
    });
    expect((await service.previewPrune(cv, "previous")).versions).toEqual([2, 1]);
  });

  it("prunes an explicit snapshot, skips a newly current version and sweeps once", async () => {
    const { owner, canvas, canvases, versions, service, engine } = await setup();
    const sweep = vi.spyOn(engine, "collectGarbage");
    const old = await ready(versions, canvas.id, owner.id, 1, manifest({ a: "one" }));
    const live = await ready(versions, canvas.id, owner.id, 2, manifest({ a: "two" }));
    await canvases.setCurrentVersion(canvas.id, live.id);
    const preview = await service.previewPrune(
      { ...canvas, currentVersionId: live.id },
      "previous",
    );
    await canvases.setCurrentVersion(canvas.id, old.id);
    expect(
      await service.prune(canvas.id, preview.versions, owner.id, preview.expectedVersionIds),
    ).toEqual({
      deleted: [],
      skipped: [{ version: 1, reason: "current" }],
    });
    expect(
      await service.prune(canvas.id, [1, 2, 2, 99], owner.id, { "1": old.id, "2": live.id }),
    ).toEqual({
      deleted: [2],
      skipped: [
        { version: 1, reason: "current" },
        { version: 99, reason: "not_found" },
      ],
    });
    expect(await versions.findById(old.id)).not.toBeNull();
    expect(sweep).toHaveBeenCalledTimes(1);
  });
  it("never deletes a replacement that reused a previewed version number", async () => {
    const { owner, canvas, versions, service } = await setup();
    const old = await ready(versions, canvas.id, owner.id, 1, manifest({ a: "old" }));
    const preview = await service.previewPrune(canvas, [1]);
    await versions.deleteReadyNonCurrent(canvas.id, 1);
    const replacement = await ready(versions, canvas.id, owner.id, 1, manifest({ a: "new" }));
    expect(replacement.id).not.toBe(old.id);
    expect(
      await service.prune(canvas.id, preview.versions, owner.id, preview.expectedVersionIds),
    ).toEqual({ deleted: [], skipped: [{ version: 1, reason: "unavailable" }] });
    expect(await versions.findById(replacement.id)).not.toBeNull();
  });
  it("protects active upload references in both the estimate and the actual sweep", async () => {
    const { owner, canvas, versions, uploadSessions, storage, service } = await setup();
    await ready(versions, canvas.id, owner.id, 1, manifest({ a: "upload-held", b: "obsolete" }));
    for (const hash of ["upload-held", "obsolete"])
      await storage.put(blobKey(canvas.id, hash), enc(hash));
    await uploadSessions.create({
      canvasId: canvas.id,
      actorId: owner.id,
      handleHash: "active",
      manifest: manifest({ a: "upload-held" }),
      stagedHashes: ["upload-held"],
      expiresAt: Date.now() + 60000,
    });
    const preview = await service.previewPrune(canvas, [1]);
    expect(preview.estimatedReclaimableBytes).toBe("obsolete".length);
    await service.prune(canvas.id, preview.versions, owner.id, preview.expectedVersionIds);
    expect(await storage.get(blobKey(canvas.id, "upload-held"))).not.toBeNull();
    expect(await storage.get(blobKey(canvas.id, "obsolete"))).toBeNull();
  });
});
