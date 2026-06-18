import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { filesRepository } from "../db/repositories/files.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { memStorage } from "../storage/mem.js";
import {
  FilesQuotaError,
  FileTooLargeError,
  filesService,
  MAX_CANVAS_BYTES,
} from "./files-service.js";

async function seed(client: DbClient): Promise<{ canvasId: string; userId: string }> {
  const u = await usersRepository(client).upsert({
    providerSub: "owner",
    email: "owner@example.com",
    name: "owner",
    isAdmin: false,
  });
  const cv = await canvasesRepository(client).create({ ownerId: u.id, slug: "s", apiKeyHash: "h" });
  return { canvasId: cv.id, userId: u.id };
}

function svc(client: DbClient, storage = memStorage()) {
  return { service: filesService({ files: filesRepository(client), storage }), storage };
}

describe.each(DIALECTS)("filesService [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("create→list→content round-trips bytes + metadata + attribution", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const { service } = svc(client);
    const bytes = new TextEncoder().encode("hello canvas");
    const row = await service.create({
      canvasId,
      filename: "a.txt",
      mime: "text/plain",
      bytes,
      userId,
    });
    expect(row.filename).toBe("a.txt");
    expect(row.sizeBytes).toBe(bytes.byteLength);
    expect(row.uploadedBy).toBe(userId);

    const list = await service.list(canvasId);
    expect(list.map((f) => f.id)).toEqual([row.id]);

    const got = await service.content(canvasId, row.id);
    expect(got && Buffer.from(got.bytes).toString()).toBe("hello canvas");
  });

  it("delete removes row + blob; content of a deleted id → null", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const { service, storage } = svc(client);
    const row = await service.create({
      canvasId,
      filename: "a.txt",
      mime: "text/plain",
      bytes: new Uint8Array([1, 2, 3]),
      userId,
    });
    expect(await service.delete(canvasId, row.id)).toBe(true);
    expect(await service.content(canvasId, row.id)).toBeNull();
    expect(await storage.exists(row.storageKey)).toBe(false);
    expect(await service.delete(canvasId, row.id)).toBe(false); // already gone
  });

  it("rejects a file over the per-file limit (FILE_TOO_LARGE)", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const { service } = svc(client);
    const tooBig = new Uint8Array(25 * 1024 * 1024 + 1);
    await expect(
      service.create({
        canvasId,
        filename: "big.bin",
        mime: "application/octet-stream",
        bytes: tooBig,
        userId,
      }),
    ).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it("rejects an upload that would exceed the per-canvas quota; totalBytes accurate", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const repo = filesRepository(client);
    // Seed metadata summing to the cap (no blobs needed — quota reads SUM(size_bytes)).
    await repo.insert({
      id: "seed",
      canvasId,
      filename: "big",
      mime: "application/octet-stream",
      sizeBytes: MAX_CANVAS_BYTES,
      storageKey: "files/x/seed",
      uploadedBy: userId,
    });
    expect(await repo.totalBytes(canvasId)).toBe(MAX_CANVAS_BYTES);
    const { service } = svc(client);
    await expect(
      service.create({
        canvasId,
        filename: "more.txt",
        mime: "text/plain",
        bytes: new Uint8Array([1]),
        userId,
      }),
    ).rejects.toBeInstanceOf(FilesQuotaError);
  });

  it("quota is best-effort: concurrent uploads near the cap can both land (KTD-4 TOCTOU)", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const repo = filesRepository(client);
    // Seed to one byte under the cap, then race two 1-byte uploads.
    await repo.insert({
      id: "seed",
      canvasId,
      filename: "big",
      mime: "application/octet-stream",
      sizeBytes: MAX_CANVAS_BYTES - 1,
      storageKey: "files/x/seed",
      uploadedBy: userId,
    });
    const { service } = svc(client);
    const results = await Promise.allSettled([
      service.create({
        canvasId,
        filename: "a",
        mime: "text/plain",
        bytes: new Uint8Array([1]),
        userId,
      }),
      service.create({
        canvasId,
        filename: "b",
        mime: "text/plain",
        bytes: new Uint8Array([1]),
        userId,
      }),
    ]);
    // Documented behavior: both can pass the check-then-write gate (overshoot by one op).
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBeGreaterThanOrEqual(1);
  });

  it("files are isolated across canvases", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const other = await canvasesRepository(client).create({
      ownerId: userId,
      slug: "other",
      apiKeyHash: "h2",
    });
    const { service } = svc(client);
    const row = await service.create({
      canvasId,
      filename: "a.txt",
      mime: "text/plain",
      bytes: new Uint8Array([1]),
      userId,
    });
    expect(await service.content(other.id, row.id)).toBeNull();
    expect(await service.delete(other.id, row.id)).toBe(false);
  });

  it("logs (does not throw) when the blob delete fails after row removal (server-canvas-6)", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const base = memStorage();
    const warns: unknown[] = [];
    const storage = { ...base, delete: () => Promise.reject(new Error("storage down")) };
    const service = filesService({
      files: filesRepository(client),
      storage: storage as typeof base,
      log: { warn: (obj: unknown) => warns.push(obj) } as never,
    });
    const row = await service.create({
      canvasId,
      filename: "a.txt",
      mime: "text/plain",
      bytes: new Uint8Array([1]),
      userId,
    });
    // The row delete succeeds; the blob delete throws but is swallowed + logged.
    expect(await service.delete(canvasId, row.id)).toBe(true);
    expect(warns.length).toBe(1);
  });

  it("cleans up the orphan blob when the row insert fails", async () => {
    client = await makeTestDb(dialect);
    await seed(client);
    const { service, storage } = svc(client);
    // Non-existent canvas → FK violation on row insert; blob must be cleaned up.
    await expect(
      service.create({
        canvasId: "ghost",
        filename: "a.txt",
        mime: "text/plain",
        bytes: new Uint8Array([1]),
        userId: "ghost",
      }),
    ).rejects.toBeDefined();
    expect(await storage.list("files/ghost")).toEqual([]);
  });
});
