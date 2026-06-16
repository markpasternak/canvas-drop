import { createHash } from "node:crypto";
import { type Config, loadConfig } from "@canvas-drop/shared";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { blobKey } from "../canvas/storage-keys.js";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { uploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import { memStorage } from "../storage/mem.js";
import { type ManifestInput, uploadService } from "./service.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const silent = pino({ level: "silent" });
const enc = (s: string) => new TextEncoder().encode(s);
const sha = (s: string) => createHash("sha256").update(enc(s)).digest("hex");
const manifestFor = (files: Record<string, string>): ManifestInput[] =>
  Object.entries(files).map(([path, content]) => ({
    path,
    hash: sha(content),
    size: enc(content).byteLength,
  }));

describe.each(DIALECTS)("uploadService (%s)", (dialect) => {
  let client: DbClient;
  let clock = 1_000_000;

  afterEach(async () => {
    await client?.close();
  });

  async function setup() {
    clock = 1_000_000;
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const uploadSessions = uploadSessionsRepository(client);
    const storage = memStorage();
    const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const other = await users.upsert({
      providerSub: "x",
      email: "x@e.com",
      name: "X",
      isAdmin: false,
    });
    const canvas = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "h" });
    const svc = uploadService({
      config,
      canvases,
      users,
      uploadSessions,
      storage,
      engine,
      log: silent,
      now: () => clock,
    });
    return {
      svc,
      users,
      canvases,
      versions,
      storage,
      canvas,
      ownerId: owner.id,
      otherId: other.id,
    };
  }

  async function stageAll(
    svc: ReturnType<typeof uploadService>,
    uploadId: string,
    ownerId: string,
    canvasId: string,
    files: Record<string, string>,
  ) {
    for (const [, content] of Object.entries(files)) {
      await svc.stageBlob(uploadId, ownerId, canvasId, sha(content), enc(content));
    }
  }

  it("begin reports all hashes missing on a fresh canvas, then stage+finalize publishes", async () => {
    const { svc, canvases, versions, storage, canvas, ownerId } = await setup();
    const files = { "index.html": "<h1>x</h1>", "app.js": "console.log(1)" };
    const { uploadId, missingHashes } = await svc.begin(canvas, ownerId, manifestFor(files));
    expect(missingHashes.sort()).toEqual([sha(files["index.html"]), sha(files["app.js"])].sort());

    await stageAll(svc, uploadId, ownerId, canvas.id, files);
    const result = await svc.finalize(uploadId, ownerId, canvas.id);
    expect(result.version).toBe(1);
    expect(result.fileCount).toBe(2);

    const after = await canvases.findById(canvas.id);
    const v = await versions.findById(after?.currentVersionId as string);
    expect(v?.status).toBe("ready");
    expect(v?.source).toBe("upload");
    expect(await storage.get(blobKey(canvas.id, sha(files["index.html"])))).not.toBeNull();
  });

  it("skip-unchanged: a re-begin with already-present blobs reports nothing missing", async () => {
    const { svc, canvas, ownerId } = await setup();
    const files = { "index.html": "same" };
    const first = await svc.begin(canvas, ownerId, manifestFor(files));
    await stageAll(svc, first.uploadId, ownerId, canvas.id, files);
    await svc.finalize(first.uploadId, ownerId, canvas.id);

    const second = await svc.begin(canvas, ownerId, manifestFor(files));
    expect(second.missingHashes).toEqual([]);
    // Finalize with zero newly-staged blobs still produces a correct version 2.
    const r2 = await svc.finalize(second.uploadId, ownerId, canvas.id);
    expect(r2.version).toBe(2);
  });

  it("rejects a non-owner caller (no existence leak)", async () => {
    const { svc, canvas, ownerId, otherId } = await setup();
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor({ "index.html": "a" }));
    await expect(svc.finalize(uploadId, otherId, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_HANDLE_INVALID",
    });
  });

  it("rejects staging a handle against the wrong canvas", async () => {
    const { svc, canvas, ownerId } = await setup();
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor({ "index.html": "a" }));
    await expect(
      svc.stageBlob(uploadId, ownerId, "some-other-canvas", sha("a"), enc("a")),
    ).rejects.toMatchObject({ code: "UPLOAD_HANDLE_INVALID" });
  });

  it("block-after-issue: owner blocked after begin fails finalize", async () => {
    const { svc, users, canvas, ownerId } = await setup();
    const files = { "index.html": "a" };
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor(files));
    await stageAll(svc, uploadId, ownerId, canvas.id, files);
    await users.setBlocked(ownerId, true);
    await expect(svc.finalize(uploadId, ownerId, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_HANDLE_INVALID",
    });
  });

  it("is single-use: a second finalize reports ALREADY_FINALIZED", async () => {
    const { svc, canvas, ownerId } = await setup();
    const files = { "index.html": "a" };
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor(files));
    await stageAll(svc, uploadId, ownerId, canvas.id, files);
    await svc.finalize(uploadId, ownerId, canvas.id);
    await expect(svc.finalize(uploadId, ownerId, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_ALREADY_FINALIZED",
    });
  });

  it("idempotent retry: finalize fails on a missing blob, then succeeds after staging it", async () => {
    const { svc, canvases, canvas, ownerId } = await setup();
    const files = { "index.html": "a", "app.js": "b" };
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor(files));
    // Stage only one of two declared blobs.
    await svc.stageBlob(uploadId, ownerId, canvas.id, sha("a"), enc("a"));
    await expect(svc.finalize(uploadId, ownerId, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_MISSING_BLOB",
    });
    // The handle was NOT consumed — stage the rest and retry.
    await svc.stageBlob(uploadId, ownerId, canvas.id, sha("b"), enc("b"));
    const result = await svc.finalize(uploadId, ownerId, canvas.id);
    expect(result.version).toBe(1);
    const after = await canvases.findById(canvas.id);
    expect(after?.currentVersionId).toBeTruthy();
  });

  it("rejects a blob whose bytes do not match its declared hash", async () => {
    const { svc, canvas, ownerId } = await setup();
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor({ "index.html": "a" }));
    await expect(
      svc.stageBlob(uploadId, ownerId, canvas.id, sha("a"), enc("tampered")),
    ).rejects.toMatchObject({ code: "BLOB_HASH_MISMATCH" });
  });

  it("enforces the aggregate canvas-size cap at finalize", async () => {
    const { svc, canvas, ownerId } = await setup();
    // Declare a manifest whose summed size exceeds 100 MB without staging the bytes.
    const huge: ManifestInput[] = [{ path: "big.bin", hash: sha("x"), size: 200 * 1024 * 1024 }];
    const { uploadId } = await svc.begin(canvas, ownerId, huge);
    await expect(svc.finalize(uploadId, ownerId, canvas.id)).rejects.toMatchObject({
      code: "CANVAS_TOO_LARGE",
    });
  });

  it("expires a session past its TTL", async () => {
    const { svc, canvas, ownerId } = await setup();
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor({ "index.html": "a" }));
    clock += 16 * 60 * 1000; // past the 15-min TTL
    await expect(svc.finalize(uploadId, ownerId, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_EXPIRED",
    });
  });

  it("rejects a zip-slip path in the begin manifest", async () => {
    const { svc, canvas, ownerId } = await setup();
    await expect(
      svc.begin(canvas, ownerId, [{ path: "../escape.html", hash: sha("a"), size: 1 }]),
    ).rejects.toMatchObject({ code: "ZIP_SLIP_REJECTED" });
  });
});
