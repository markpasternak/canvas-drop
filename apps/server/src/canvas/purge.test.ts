import type { Manifest } from "@canvas-drop/shared/db";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { screenshotsRepository } from "../db/repositories/screenshots.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";
import { memStorage } from "../storage/mem.js";
import { purgeDeletedCanvases } from "./purge.js";
import { blobKey, canvasBlobPrefix, screenshotKey, screenshotPrefix } from "./storage-keys.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const log = { info() {}, error() {} } as unknown as Logger;

describe.each(DIALECTS)("purgeDeletedCanvases [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  const deps = (storage: StorageDriver) => ({
    canvases: canvasesRepository(client),
    versions: versionsRepository(client),
    drafts: draftsRepository(client),
    screenshots: screenshotsRepository(client),
    storage,
    log,
  });

  /** A canvas with one ready version pointing at one content-addressed blob. */
  async function seedCanvas(
    client: DbClient,
    storage: StorageDriver,
    ownerId: string,
    slug: string,
  ): Promise<string> {
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const cv = await canvases.create({ ownerId, slug, apiKeyHash: `k-${slug}` });
    const hash = `hash-${slug}`;
    const manifest: Manifest = { "index.html": { size: 5, hash, mime: "text/html" } };
    const v = await versions.createPending({
      canvasId: cv.id,
      number: 1,
      createdBy: ownerId,
      source: "api",
    });
    await versions.markReady(v.id, { fileCount: 1, totalBytes: 5, manifest });
    await storage.put(blobKey(cv.id, hash), new TextEncoder().encode("hello"));
    return cv.id;
  }

  async function seedOwner(client: DbClient): Promise<string> {
    const u = await usersRepository(client).upsert({
      providerSub: "owner",
      email: "owner@example.com",
      name: "owner",
      isAdmin: false,
    });
    return u.id;
  }

  it("reclaims blobs + versions of soft-deleted canvases, keeps the row, leaves active ones untouched", async () => {
    client = await makeTestDb(dialect);
    const storage = memStorage();
    const ownerId = await seedOwner(client);
    const canvases = canvasesRepository(client);

    const deletedId = await seedCanvas(client, storage, ownerId, "gone");
    const liveId = await seedCanvas(client, storage, ownerId, "alive");
    await canvases.setStatus(deletedId, "deleted");

    const summary = await purgeDeletedCanvases(deps(storage));

    expect(summary).toMatchObject({
      canvasesPurged: 1,
      versionsPurged: 1,
      objectsDeleted: 1,
      failed: 0,
    });
    const tombstone = await canvases.findById(deletedId);
    expect(tombstone).not.toBeNull();
    expect(tombstone?.status).toBe("deleted");
    expect(tombstone?.currentVersionId).toBeNull();
    expect(await versionsRepository(client).listByCanvas(deletedId)).toEqual([]);
    // The deleted canvas's blobs are gone; the live canvas's remain.
    expect(await storage.list(canvasBlobPrefix(deletedId))).toHaveLength(0);
    expect(await storage.list(canvasBlobPrefix(liveId))).toHaveLength(1);
    expect(await canvases.findById(liveId)).not.toBeNull();
    expect(await versionsRepository(client).listByCanvas(liveId)).toHaveLength(1);
  });

  it("reclaims a canvas's draft row too (drafted, soft-deleted)", async () => {
    client = await makeTestDb(dialect);
    const storage = memStorage();
    const ownerId = await seedOwner(client);
    const canvases = canvasesRepository(client);
    const drafts = draftsRepository(client);

    const id = await seedCanvas(client, storage, ownerId, "drafted");
    await drafts.create({
      canvasId: id,
      manifest: { "index.html": { size: 5, hash: "hash-drafted", mime: "text/html" } },
      baseVersionId: null,
    });
    await canvases.setStatus(id, "deleted");

    const summary = await purgeDeletedCanvases(deps(storage));
    expect(summary.canvasesPurged).toBe(1);
    expect(await drafts.getByCanvas(id)).toBeNull();
    expect(await storage.list(canvasBlobPrefix(id))).toHaveLength(0);
  });

  it("is idempotent: a never-deployed canvas is skipped and a second sweep reclaims nothing", async () => {
    client = await makeTestDb(dialect);
    const storage = memStorage();
    const ownerId = await seedOwner(client);
    const canvases = canvasesRepository(client);

    const neverDeployed = await canvases.create({ ownerId, slug: "bare", apiKeyHash: "k" });
    await canvases.setStatus(neverDeployed.id, "deleted");
    const deployed = await seedCanvas(client, storage, ownerId, "had-files");
    await canvases.setStatus(deployed, "deleted");

    const first = await purgeDeletedCanvases(deps(storage));
    expect(first.canvasesPurged).toBe(1); // only the one with blobs/versions
    const second = await purgeDeletedCanvases(deps(storage));
    expect(second).toMatchObject({ canvasesPurged: 0, versionsPurged: 0, objectsDeleted: 0 });
    expect(await canvases.findById(neverDeployed.id)).not.toBeNull();
    expect(await canvases.findById(deployed)).not.toBeNull();
  });

  it("honors the retention window: too-recent deletions survive, old ones are purged", async () => {
    client = await makeTestDb(dialect);
    const storage = memStorage();
    const ownerId = await seedOwner(client);
    const canvases = canvasesRepository(client);

    const id = await seedCanvas(client, storage, ownerId, "gone");
    await canvases.setStatus(id, "deleted");
    const deletedAt = (await canvases.findById(id))?.deletedAt as number;

    const recent = await purgeDeletedCanvases(deps(storage), {
      olderThanDays: 30,
      now: deletedAt + DAY_MS,
    });
    expect(recent.canvasesPurged).toBe(0);
    expect(await versionsRepository(client).listByCanvas(id)).toHaveLength(1);

    const aged = await purgeDeletedCanvases(deps(storage), {
      olderThanDays: 30,
      now: deletedAt + 31 * DAY_MS,
    });
    expect(aged.canvasesPurged).toBe(1);
    expect(await canvases.findById(id)).not.toBeNull();
    expect(await versionsRepository(client).listByCanvas(id)).toEqual([]);
  });

  it("dry-run reports what would be purged but deletes nothing", async () => {
    client = await makeTestDb(dialect);
    const storage = memStorage();
    const ownerId = await seedOwner(client);
    const canvases = canvasesRepository(client);

    const id = await seedCanvas(client, storage, ownerId, "gone");
    await canvases.setStatus(id, "deleted");

    const summary = await purgeDeletedCanvases(deps(storage), { dryRun: true });

    expect(summary).toMatchObject({ canvasesPurged: 1, versionsPurged: 1, objectsDeleted: 1 });
    expect(await canvases.findById(id)).not.toBeNull();
    expect(await versionsRepository(client).listByCanvas(id)).toHaveLength(1);
    expect(await storage.list(canvasBlobPrefix(id))).toHaveLength(1);
  });

  it("isolates a per-canvas failure: rows stay intact for retry, others still purge", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const canvases = canvasesRepository(client);

    const storage = memStorage();
    const okId = await seedCanvas(client, storage, ownerId, "ok");
    const badId = await seedCanvas(client, storage, ownerId, "bad");
    await canvases.setStatus(okId, "deleted");
    await canvases.setStatus(badId, "deleted");

    // Deleting the "bad" canvas's blobs throws, so its purge aborts while the
    // healthy canvas still reclaims.
    const guarded: StorageDriver = {
      ...storage,
      deleteMany: async (keys: string[]) => {
        if (keys.some((k) => k.startsWith(canvasBlobPrefix(badId)))) {
          throw new Error("storage down");
        }
        return storage.deleteMany(keys);
      },
    };

    const summary = await purgeDeletedCanvases(deps(guarded));

    expect(summary.canvasesPurged).toBe(1);
    expect(summary.failed).toBe(1);
    expect(await versionsRepository(client).listByCanvas(badId)).toHaveLength(1);
    expect(await canvases.findById(okId)).not.toBeNull();
    expect(await versionsRepository(client).listByCanvas(okId)).toEqual([]);
  });

  it("reclaims the canvas's preview prefix + screenshot job row (plan 004 / U10)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const storage = memStorage();
    const canvases = canvasesRepository(client);
    const screenshots = screenshotsRepository(client);
    const id = await seedCanvas(client, storage, ownerId, "shot");
    // A captured preview + its job row.
    await storage.put(screenshotKey(id, "og"), new Uint8Array([1]), { contentType: "image/webp" });
    await storage.put(screenshotKey(id, "card"), new Uint8Array([2]), {
      contentType: "image/webp",
    });
    await screenshots.enqueue(id, "v-1");
    await canvases.setStatus(id, "deleted");

    await purgeDeletedCanvases(deps(storage));

    expect(await storage.list(screenshotPrefix(id))).toHaveLength(0);
    expect(await screenshots.findByCanvas(id)).toBeNull();
  });
});
