import type { Manifest } from "@canvas-drop/shared/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import { draftsRepository } from "./drafts.js";
import { usersRepository } from "./users.js";

const man = (paths: Record<string, string>): Manifest =>
  Object.fromEntries(
    Object.entries(paths).map(([p, hash]) => [p, { size: hash.length, hash, mime: "text/html" }]),
  );

describe.each(DIALECTS)("draftsRepository (%s)", (dialect) => {
  let client: DbClient;
  let drafts: ReturnType<typeof draftsRepository>;
  let canvasId: string;

  beforeEach(async () => {
    client = await makeTestDb(dialect);
    drafts = draftsRepository(client);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const user = await users.upsert({
      providerSub: "p|1",
      email: "o@example.com",
      name: "Owner",
      avatarUrl: null,
      isAdmin: false,
    });
    const canvas = await canvases.create({
      slug: "quiet-otter-x7k2",
      ownerId: user.id,
      apiKeyHash: "kh",
    });
    canvasId = canvas.id;
  });

  afterEach(async () => {
    await client.close();
  });

  it("creates and reads exactly one draft per canvas", async () => {
    const created = await drafts.create({
      canvasId,
      manifest: man({ "index.html": "a".repeat(64) }),
      baseVersionId: null,
    });
    expect(created.canvasId).toBe(canvasId);
    expect(created.stale).toBe(false);
    const got = await drafts.getByCanvas(canvasId);
    expect(got?.id).toBe(created.id);
    expect(got?.manifest).toEqual(man({ "index.html": "a".repeat(64) }));
  });

  it("rejects a second draft for the same canvas (unique canvas_id)", async () => {
    await drafts.create({ canvasId, manifest: {}, baseVersionId: null });
    await expect(drafts.create({ canvasId, manifest: {}, baseVersionId: null })).rejects.toThrow();
  });

  it("setManifest replaces the manifest, bumps updatedAt, clears stale", async () => {
    const created = await drafts.create({ canvasId, manifest: {}, baseVersionId: null });
    await drafts.markStale(canvasId);
    const next = man({ "page.html": "b".repeat(64) });
    const updated = await drafts.setManifest(canvasId, next);
    expect(updated.manifest).toEqual(next);
    expect(updated.stale).toBe(false);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it("resetToBase swaps manifest + base version and clears stale", async () => {
    await drafts.create({
      canvasId,
      manifest: man({ "a.html": "1".repeat(64) }),
      baseVersionId: null,
    });
    await drafts.markStale(canvasId);
    const restored = await drafts.resetToBase(canvasId, man({ "b.html": "2".repeat(64) }), "ver-2");
    expect(restored.manifest).toEqual(man({ "b.html": "2".repeat(64) }));
    expect(restored.baseVersionId).toBe("ver-2");
    expect(restored.stale).toBe(false);
  });

  it("markStale sets stale without touching the manifest", async () => {
    const m = man({ "index.html": "c".repeat(64) });
    await drafts.create({ canvasId, manifest: m, baseVersionId: null });
    await drafts.markStale(canvasId);
    const got = await drafts.getByCanvas(canvasId);
    expect(got?.stale).toBe(true);
    expect(got?.manifest).toEqual(m);
  });

  it("deleteByCanvas removes the draft", async () => {
    await drafts.create({ canvasId, manifest: {}, baseVersionId: null });
    await drafts.deleteByCanvas(canvasId);
    expect(await drafts.getByCanvas(canvasId)).toBeNull();
  });
});
