import type { Manifest } from "@canvas-drop/shared/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import { CONSUMED_GRACE_MS, uploadSessionsRepository } from "./upload-sessions.js";
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
    actorId: ownerId,
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
    // A just-consumed session stays in the live set for the grace window (a handle a
    // publication conflict un-consumes must keep its staged blobs covered, KTD11).
    expect(ids).toContain(consumed.id);
    expect(ids).not.toContain(expired.id);
    // Past the grace window a consumed session drops out (expiry kept far away).
    const longLived = await sessions.create({
      ...base(),
      handleHash: "l".repeat(64),
      expiresAt: Date.now() + 10 * CONSUMED_GRACE_MS,
    });
    await sessions.markConsumed(longLived.id);
    const later = await sessions.listActiveByCanvas(canvasId, Date.now() + CONSUMED_GRACE_MS + 1);
    expect(later.map((s) => s.id)).not.toContain(longLived.id);
  });

  it("round-trips the coordination fields captured at begin", async () => {
    const created = await sessions.create({
      ...base(),
      releaseId: "gh:acme/roadmap@3f9c2e1:prod",
      expectedPublicationToken: "9f2c4e7a1b3d5f60718293a4b5c6d7e8",
    });
    expect(created.releaseId).toBe("gh:acme/roadmap@3f9c2e1:prod");
    expect(created.expectedPublicationToken).toBe("9f2c4e7a1b3d5f60718293a4b5c6d7e8");
    const bare = await sessions.create({ ...base(), handleHash: "b".repeat(64) });
    expect(bare.releaseId).toBeNull();
    expect(bare.expectedPublicationToken).toBeNull();
  });

  it("unconsume clears both the consumed marker and the finalize lease", async () => {
    const s = await sessions.create(base());
    const claimed = await sessions.claimForFinalize(s.handleHash, 0);
    expect(claimed).not.toBeNull();
    await sessions.markConsumed(s.id);
    expect(await sessions.unconsume(s.id, claimed?.finalizingAt ?? null)).toBe(true);
    const again = await sessions.findByHandleHash(s.handleHash);
    expect(again?.consumedAt).toBeNull();
    expect(again?.finalizingAt).toBeNull();
    // and the handle can be claimed again
    expect(await sessions.claimForFinalize(s.handleHash, 0)).not.toBeNull();
  });

  it("unconsume is fenced on the lease: a stale claimant cannot reopen a handle a newer attempt consumed", async () => {
    const s = await sessions.create(base());
    const stale = await sessions.claimForFinalize(s.handleHash, 0);
    expect(stale).not.toBeNull();
    // The first attempt outlives its lease; the retry re-claims with a newer stamp and consumes.
    await new Promise((r) => setTimeout(r, 5));
    const newer = await sessions.claimForFinalize(s.handleHash, Date.now() + 1);
    expect(newer).not.toBeNull();
    expect(newer?.finalizingAt).not.toBe(stale?.finalizingAt);
    await sessions.markConsumed(s.id);
    expect(await sessions.unconsume(s.id, stale?.finalizingAt ?? null)).toBe(false);
    const row = await sessions.findByHandleHash(s.handleHash);
    expect(row?.consumedAt).not.toBeNull();
    expect(row?.finalizingAt).toBe(newer?.finalizingAt);
    // The attempt that holds the current lease may still reopen it.
    expect(await sessions.unconsume(s.id, newer?.finalizingAt ?? null)).toBe(true);
    expect((await sessions.findByHandleHash(s.handleHash))?.consumedAt).toBeNull();
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
