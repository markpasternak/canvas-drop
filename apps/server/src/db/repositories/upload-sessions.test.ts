import type { Manifest } from "@canvas-drop/shared/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import { uploadSessionsRepository } from "./upload-sessions.js";
import { usersRepository } from "./users.js";
import { versionsRepository } from "./versions.js";

const man = (paths: Record<string, string>): Manifest =>
  Object.fromEntries(
    Object.entries(paths).map(([p, hash]) => [p, { size: hash.length, hash, mime: "text/html" }]),
  );

describe.each(DIALECTS)("uploadSessionsRepository (%s)", (dialect) => {
  let client: DbClient;
  let sessions: ReturnType<typeof uploadSessionsRepository>;
  let ownerId: string;
  let canvasId: string;

  const base = () => ({
    canvasId,
    ownerId,
    handleHash: "h".repeat(64),
    manifest: man({ "index.html": "a".repeat(64) }),
    stagedHashes: [] as string[],
    expiresAt: Date.now() + 60_000,
  });

  beforeEach(async () => {
    client = await makeTestDb(dialect);
    sessions = uploadSessionsRepository(client);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const user = await users.upsert({
      providerSub: "p|1",
      email: "o@example.com",
      name: "Owner",
      avatarUrl: null,
      isAdmin: false,
    });
    ownerId = user.id;
    const canvas = await canvases.create({
      slug: "quiet-otter-x7k2",
      ownerId,
      apiKeyHash: "kh",
    });
    canvasId = canvas.id;
  });

  afterEach(async () => {
    await client.close();
  });

  it("creates and reads a session by handle hash", async () => {
    const created = await sessions.create(base());
    expect(created.canvasId).toBe(canvasId);
    expect(created.consumedAt).toBeNull();
    const got = await sessions.findByHandleHash("h".repeat(64));
    expect(got?.id).toBe(created.id);
    expect(got?.manifest).toEqual(man({ "index.html": "a".repeat(64) }));
  });

  it("findByHandleHash returns null for an unknown handle", async () => {
    expect(await sessions.findByHandleHash("z".repeat(64))).toBeNull();
  });

  it("setStaged replaces the staged-hash set", async () => {
    const s = await sessions.create(base());
    await sessions.setStaged(s.id, ["x".repeat(64)]);
    const got = await sessions.findByHandleHash(s.handleHash);
    expect(got?.stagedHashes).toEqual(["x".repeat(64)]);
  });

  it("claimForFinalize is single-use under concurrency, then markConsumed is terminal", async () => {
    const s = await sessions.create(base());
    const now = Date.now();
    const [a, b] = await Promise.all([
      sessions.claimForFinalize(s.handleHash, now - 60_000),
      sessions.claimForFinalize(s.handleHash, now - 60_000),
    ]);
    // Exactly one claim wins (the other sees finalizing_at already set, newer than lease).
    expect([a, b].filter(Boolean)).toHaveLength(1);
    await sessions.markConsumed(s.id);
    // After consume, no further claim succeeds.
    expect(await sessions.claimForFinalize(s.handleHash, Date.now())).toBeNull();
  });

  it("clearFinalizing releases the lease so a legitimate retry can re-claim", async () => {
    const s = await sessions.create(base());
    const claimed = await sessions.claimForFinalize(s.handleHash, Date.now() - 60_000);
    expect(claimed).not.toBeNull();
    // A second immediate claim fails (held).
    expect(await sessions.claimForFinalize(s.handleHash, Date.now() - 60_000)).toBeNull();
    // Transient failure path clears the lease.
    await sessions.clearFinalizing(s.id);
    expect(await sessions.claimForFinalize(s.handleHash, Date.now() - 60_000)).not.toBeNull();
  });

  it("listActiveByCanvas returns only unconsumed, unexpired sessions", async () => {
    const active = await sessions.create(base());
    const consumed = await sessions.create({ ...base(), handleHash: "c".repeat(64) });
    await sessions.markConsumed(consumed.id);
    const expired = await sessions.create({
      ...base(),
      handleHash: "e".repeat(64),
      expiresAt: Date.now() - 1,
    });
    const live = await sessions.listActiveByCanvas(canvasId, Date.now());
    const ids = live.map((s) => s.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(consumed.id);
    expect(ids).not.toContain(expired.id);
  });

  it("deleteExpired removes only rows past the cutoff", async () => {
    const fresh = await sessions.create(base());
    const stale = await sessions.create({
      ...base(),
      handleHash: "s".repeat(64),
      expiresAt: Date.now() - 10_000,
    });
    await sessions.deleteExpired(Date.now());
    expect(await sessions.findByHandleHash(fresh.handleHash)).not.toBeNull();
    expect(await sessions.findByHandleHash(stale.handleHash)).toBeNull();
  });

  it("versions_source_chk accepts the 'upload' source on both dialects", async () => {
    const versions = versionsRepository(client);
    const v = await versions.createPending({
      canvasId,
      number: 1,
      createdBy: ownerId,
      source: "upload",
    });
    expect(v.source).toBe("upload");
  });
});
