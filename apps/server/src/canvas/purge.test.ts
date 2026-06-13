import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";
import { memStorage } from "../storage/mem.js";
import { purgeDeletedCanvases } from "./purge.js";
import { versionPrefix, versionStorageKey } from "./storage-keys.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const log = { info() {}, error() {} } as unknown as Logger;

describe.each(DIALECTS)("purgeDeletedCanvases [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  /** A canvas with one ready version and one stored file under that version. */
  async function seedCanvas(
    client: DbClient,
    storage: StorageDriver,
    ownerId: string,
    slug: string,
  ): Promise<string> {
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const cv = await canvases.create({ ownerId, slug, apiKeyHash: `k-${slug}` });
    const v = await versions.createPending({
      canvasId: cv.id,
      number: 1,
      createdBy: ownerId,
      source: "api",
    });
    await versions.markReady(v.id, { fileCount: 1, totalBytes: 5, manifest: {} });
    await storage.put(versionStorageKey(v.id, "index.html"), new TextEncoder().encode("hello"));
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

  it("reclaims files + versions of soft-deleted canvases, keeps the row, leaves active ones untouched", async () => {
    client = await makeTestDb(dialect);
    const storage = memStorage();
    const ownerId = await seedOwner(client);
    const canvases = canvasesRepository(client);

    const deletedId = await seedCanvas(client, storage, ownerId, "gone");
    const liveId = await seedCanvas(client, storage, ownerId, "alive");
    await canvases.setStatus(deletedId, "deleted");

    const summary = await purgeDeletedCanvases({
      canvases,
      versions: versionsRepository(client),
      storage,
      log,
    });

    expect(summary).toMatchObject({
      canvasesPurged: 1,
      versionsPurged: 1,
      objectsDeleted: 1,
      failed: 0,
    });
    // The canvas ROW survives as a soft-deleted tombstone — but its version,
    // its file, and its current-version pointer are gone.
    const tombstone = await canvases.findById(deletedId);
    expect(tombstone).not.toBeNull();
    expect(tombstone?.status).toBe("deleted");
    expect(tombstone?.currentVersionId).toBeNull();
    expect(await versionsRepository(client).listByCanvas(deletedId)).toEqual([]);
    expect(await storage.list("versions/")).toHaveLength(1); // only the live canvas's object remains
    // The active canvas is fully intact.
    expect(await canvases.findById(liveId)).not.toBeNull();
    expect(await versionsRepository(client).listByCanvas(liveId)).toHaveLength(1);
  });

  it("is idempotent: a canvas with no versions is skipped and a second sweep reclaims nothing", async () => {
    client = await makeTestDb(dialect);
    const storage = memStorage();
    const ownerId = await seedOwner(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);

    // A soft-deleted canvas that was never deployed (no versions) is left alone.
    const neverDeployed = await canvases.create({ ownerId, slug: "bare", apiKeyHash: "k" });
    await canvases.setStatus(neverDeployed.id, "deleted");
    const deployed = await seedCanvas(client, storage, ownerId, "had-files");
    await canvases.setStatus(deployed, "deleted");

    const first = await purgeDeletedCanvases({ canvases, versions, storage, log });
    expect(first.canvasesPurged).toBe(1); // only the one with versions
    // Re-running finds nothing reclaimable — both rows still exist as tombstones.
    const second = await purgeDeletedCanvases({ canvases, versions, storage, log });
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

    // 30-day window, evaluated one day after deletion → still within retention.
    const recent = await purgeDeletedCanvases(
      { canvases, versions: versionsRepository(client), storage, log },
      { olderThanDays: 30, now: deletedAt + DAY_MS },
    );
    expect(recent.canvasesPurged).toBe(0);
    expect(await versionsRepository(client).listByCanvas(id)).toHaveLength(1); // untouched

    // Same window, evaluated 31 days later → now past retention, reclaimed.
    const aged = await purgeDeletedCanvases(
      { canvases, versions: versionsRepository(client), storage, log },
      { olderThanDays: 30, now: deletedAt + 31 * DAY_MS },
    );
    expect(aged.canvasesPurged).toBe(1);
    expect(await canvases.findById(id)).not.toBeNull(); // tombstone kept
    expect(await versionsRepository(client).listByCanvas(id)).toEqual([]); // files + versions gone
  });

  it("dry-run reports what would be purged but deletes nothing", async () => {
    client = await makeTestDb(dialect);
    const storage = memStorage();
    const ownerId = await seedOwner(client);
    const canvases = canvasesRepository(client);

    const id = await seedCanvas(client, storage, ownerId, "gone");
    await canvases.setStatus(id, "deleted");

    const summary = await purgeDeletedCanvases(
      { canvases, versions: versionsRepository(client), storage, log },
      { dryRun: true },
    );

    expect(summary).toMatchObject({ canvasesPurged: 1, versionsPurged: 1, objectsDeleted: 1 });
    // Nothing was actually removed.
    expect(await canvases.findById(id)).not.toBeNull();
    expect(await versionsRepository(client).listByCanvas(id)).toHaveLength(1);
    expect(await storage.list("versions/")).toHaveLength(1);
  });

  it("isolates a per-canvas failure: rows stay intact for retry, others still purge", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);

    const storage = memStorage();
    const okId = await seedCanvas(client, storage, ownerId, "ok");
    const badId = await seedCanvas(client, storage, ownerId, "bad");
    await canvases.setStatus(okId, "deleted");
    await canvases.setStatus(badId, "deleted");

    // The "bad" canvas's version prefix — deleting any object under it throws,
    // so its purge aborts mid-way while the healthy canvas still purges.
    const [badVersion] = await versions.listByCanvas(badId);
    if (!badVersion) throw new Error("seed failed: bad canvas has no version");
    const guarded: StorageDriver = {
      ...storage,
      delete: async (key: string) => {
        if (key.startsWith(versionPrefix(badVersion.id))) throw new Error("storage down");
        return storage.delete(key);
      },
    };

    const summary = await purgeDeletedCanvases({ canvases, versions, storage: guarded, log }, {});

    expect(summary.canvasesPurged).toBe(1);
    expect(summary.failed).toBe(1);
    // The failed canvas is fully intact (row + version), safe to retry.
    expect(await versionsRepository(client).listByCanvas(badId)).toHaveLength(1);
    // The healthy one was reclaimed: row kept as a tombstone, versions gone.
    expect(await canvases.findById(okId)).not.toBeNull();
    expect(await versionsRepository(client).listByCanvas(okId)).toEqual([]);
  });
});
