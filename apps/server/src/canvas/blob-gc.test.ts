import type { Manifest } from "@canvas-drop/shared/db";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { uploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import type { Logger } from "../log/logger.js";
import { memStorage } from "../storage/mem.js";
import { collectGarbage } from "./blob-gc.js";
import { blobKey, canvasBlobPrefix } from "./storage-keys.js";

const log = { info() {}, error() {} } as unknown as Logger;
const enc = (s: string) => new TextEncoder().encode(s);
const m = (hashes: string[]): Manifest =>
  Object.fromEntries(hashes.map((h, i) => [`f${i}.html`, { size: 1, hash: h, mime: "text/html" }]));

describe.each(DIALECTS)("collectGarbage (blob mark-sweep) [%s]", (dialect) => {
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
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const cv = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "k" });
    return { canvases, versions, drafts, owner, canvasId: cv.id };
  }

  async function makeReady(
    versions: ReturnType<typeof versionsRepository>,
    canvasId: string,
    ownerId: string,
    number: number,
    manifest: Manifest,
  ) {
    const v = await versions.createPending({ canvasId, number, createdBy: ownerId, source: "api" });
    await versions.markReady(v.id, { fileCount: 1, totalBytes: 1, manifest });
    return v;
  }

  it("keeps blobs referenced by a surviving version or the draft, deletes the rest (AE4)", async () => {
    const { versions, drafts, canvasId, owner } = await setup();
    const storage = memStorage();
    // v2 is the only surviving ready version: references a, b, d. Draft references e.
    await makeReady(versions, canvasId, owner.id, 2, m(["a", "b", "d"]));
    await drafts.create({ canvasId, manifest: m(["e"]), baseVersionId: null });
    // Blobs present on disk: a,b,c,d,e (c is an orphan from a pruned v1).
    for (const h of ["a", "b", "c", "d", "e"]) await storage.put(blobKey(canvasId, h), enc(h));

    await collectGarbage({ versions, drafts, storage, log }, canvasId);

    const remaining = (await storage.list(canvasBlobPrefix(canvasId))).map((k) =>
      k.slice(canvasBlobPrefix(canvasId).length),
    );
    expect(remaining.sort()).toEqual(["a", "b", "d", "e"]); // c (unreferenced) deleted, a,b still kept
  });

  it("retains a draft-only blob, then sweeps it once the draft drops it", async () => {
    const { drafts, versions, canvasId } = await setup();
    const storage = memStorage();
    await drafts.create({ canvasId, manifest: m(["x"]), baseVersionId: null });
    await storage.put(blobKey(canvasId, "x"), enc("x"));

    await collectGarbage({ versions, drafts, storage, log }, canvasId);
    expect(await storage.list(canvasBlobPrefix(canvasId))).toHaveLength(1); // x retained (draft refs it)

    await drafts.setManifest(canvasId, {}); // draft no longer references x
    await collectGarbage({ versions, drafts, storage, log }, canvasId);
    expect(await storage.list(canvasBlobPrefix(canvasId))).toHaveLength(0); // now swept
  });

  it("deletes a blob referenced only by a row-deleted (pruned) version", async () => {
    const { versions, drafts, canvasId, owner } = await setup();
    const storage = memStorage();
    await makeReady(versions, canvasId, owner.id, 1, m(["gone"]));
    await storage.put(blobKey(canvasId, "gone"), enc("gone"));
    // Simulate row prune: delete the version row, leaving the blob orphaned.
    await versions.deleteByCanvas(canvasId);

    await collectGarbage({ versions, drafts, storage, log }, canvasId);
    expect(await storage.list(canvasBlobPrefix(canvasId))).toHaveLength(0);
  });

  it("a pending (not ready) version does not keep its blobs alive", async () => {
    const { versions, drafts, canvasId, owner } = await setup();
    const storage = memStorage();
    await versions.createPending({ canvasId, number: 1, createdBy: owner.id, source: "api" });
    await storage.put(blobKey(canvasId, "p"), enc("p")); // written but version never readied
    await collectGarbage({ versions, drafts, storage, log }, canvasId);
    expect(await storage.list(canvasBlobPrefix(canvasId))).toHaveLength(0);
  });

  it("no versions and an empty draft → reclaims all stray blobs without error", async () => {
    const { versions, drafts, canvasId } = await setup();
    const storage = memStorage();
    for (const h of ["1", "2", "3"]) await storage.put(blobKey(canvasId, h), enc(h));
    await collectGarbage({ versions, drafts, storage, log }, canvasId);
    expect(await storage.list(canvasBlobPrefix(canvasId))).toHaveLength(0);
  });

  it("swallows a storage failure (never throws)", async () => {
    const { versions, drafts, canvasId } = await setup();
    const storage = memStorage();
    storage.deleteMany = async () => {
      throw new Error("storage down");
    };
    await storage.put(blobKey(canvasId, "z"), enc("z"));
    await expect(
      collectGarbage({ versions, drafts, storage, log }, canvasId),
    ).resolves.toBeUndefined();
  });

  it("keeps a blob referenced only by an active upload session, sweeps it once expired (plan 003 U7)", async () => {
    const { versions, drafts, canvasId, owner } = await setup();
    const uploadSessions = uploadSessionsRepository(client);
    const storage = memStorage();
    // A blob staged into an active session — referenced by no version or draft yet.
    await storage.put(blobKey(canvasId, "staged"), enc("staged"));
    await uploadSessions.create({
      canvasId,
      ownerId: owner.id,
      handleHash: "h".repeat(64),
      manifest: m(["staged"]),
      stagedHashes: ["staged"],
      expiresAt: Date.now() + 60_000,
    });

    await collectGarbage({ versions, drafts, storage, log, uploadSessions }, canvasId);
    expect(await storage.list(canvasBlobPrefix(canvasId))).toHaveLength(1); // retained — session live

    // Expire + prune the session: the blob is now an orphan and is reclaimed.
    await uploadSessions.deleteExpired(Date.now() + 120_000);
    await collectGarbage({ versions, drafts, storage, log, uploadSessions }, canvasId);
    expect(await storage.list(canvasBlobPrefix(canvasId))).toHaveLength(0);
  });
});
