import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import { guestRepository } from "./guest.js";
import { usersRepository } from "./users.js";

const HOUR = 60 * 60 * 1000;

/** Seed an owner + a canvas; guest invites reference canvas_id (FK). */
async function seedCanvas(client: DbClient): Promise<string> {
  const owner = await usersRepository(client).upsert({
    providerSub: "owner",
    email: "owner@example.com",
    name: "Owner",
    isAdmin: false,
  });
  const canvas = await canvasesRepository(client).create({
    ownerId: owner.id,
    slug: "guest-host-0001",
    apiKeyHash: "h1",
  });
  return canvas.id;
}

describe.each(DIALECTS)("guestRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("createInvite is idempotent per (canvas, email) — re-inviting resets to pending with a fresh token", async () => {
    client = await makeTestDb(dialect);
    const canvasId = await seedCanvas(client);
    const repo = guestRepository(client);

    const first = await repo.createInvite({
      canvasId,
      email: "guest@example.com",
      tokenHash: "hash-one",
      expiresAt: Date.now() + HOUR,
    });
    // Consume it so state is no longer pending, then re-invite the same email.
    expect(await repo.markConsumed(first.id)).toBe(true);

    const second = await repo.createInvite({
      canvasId,
      email: "guest@example.com",
      tokenHash: "hash-two",
      expiresAt: Date.now() + HOUR,
    });
    // Same row (one invite per canvas/email), reset to pending with the new token.
    expect(second.id).toBe(first.id);
    expect(second.state).toBe("pending");
    expect(second.consumedAt).toBeNull();
    expect(await repo.findInviteByTokenHash("hash-two")).not.toBeNull();
    const invites = await repo.listInvitesByCanvas(canvasId);
    expect(invites).toHaveLength(1);
  });

  it("markConsumed is a single-use CAS: only the first flip from pending succeeds", async () => {
    client = await makeTestDb(dialect);
    const canvasId = await seedCanvas(client);
    const repo = guestRepository(client);
    const invite = await repo.createInvite({
      canvasId,
      email: "guest@example.com",
      tokenHash: "hash",
      expiresAt: Date.now() + HOUR,
    });

    expect(await repo.markConsumed(invite.id)).toBe(true);
    // A replay (or concurrent second magic-link click) finds no pending row.
    expect(await repo.markConsumed(invite.id)).toBe(false);
  });

  it("findLiveSessionByTokenHash excludes revoked and expired sessions", async () => {
    client = await makeTestDb(dialect);
    const canvasId = await seedCanvas(client);
    const repo = guestRepository(client);
    const invite = await repo.createInvite({
      canvasId,
      email: "guest@example.com",
      tokenHash: "ih",
      expiresAt: Date.now() + HOUR,
    });

    const live = await repo.createSession({
      inviteId: invite.id,
      canvasId,
      tokenHash: "live-sess",
      expiresAt: Date.now() + HOUR,
    });
    const expired = await repo.createSession({
      inviteId: invite.id,
      canvasId,
      tokenHash: "expired-sess",
      expiresAt: Date.now() - 1,
    });

    expect((await repo.findLiveSessionByTokenHash("live-sess"))?.id).toBe(live.id);
    expect(await repo.findLiveSessionByTokenHash("expired-sess")).toBeNull();
    expect(expired.id).toBeTruthy();

    // Revoke via revokeAllForCanvas → the live session is no longer findable.
    await repo.revokeAllForCanvas(canvasId);
    expect(await repo.findLiveSessionByTokenHash("live-sess")).toBeNull();
  });

  it("revokeInvite flips the invite to revoked and revokes its sessions", async () => {
    client = await makeTestDb(dialect);
    const canvasId = await seedCanvas(client);
    const repo = guestRepository(client);
    const invite = await repo.createInvite({
      canvasId,
      email: "guest@example.com",
      tokenHash: "ih",
      expiresAt: Date.now() + HOUR,
    });
    await repo.createSession({
      inviteId: invite.id,
      canvasId,
      tokenHash: "sess",
      expiresAt: Date.now() + HOUR,
    });

    await repo.revokeInvite(canvasId, "guest@example.com");
    expect((await repo.findInviteById(invite.id))?.state).toBe("revoked");
    expect(await repo.findLiveSessionByTokenHash("sess")).toBeNull();
  });

  it("pruneDeadBefore removes revoked/expired invites past the cutoff (and their sessions), keeping live ones", async () => {
    client = await makeTestDb(dialect);
    const canvasId = await seedCanvas(client);
    const repo = guestRepository(client);
    const now = Date.now();

    // Live invite (unexpired, pending) — must survive.
    const live = await repo.createInvite({
      canvasId,
      email: "live@example.com",
      tokenHash: "live",
      expiresAt: now + HOUR,
    });
    // Expired-before-cutoff invite — must be pruned, along with its session.
    const expired = await repo.createInvite({
      canvasId,
      email: "expired@example.com",
      tokenHash: "expired",
      expiresAt: now - 2 * HOUR,
    });
    await repo.createSession({
      inviteId: expired.id,
      canvasId,
      tokenHash: "expired-sess",
      expiresAt: now - 2 * HOUR,
    });

    const removed = await repo.pruneDeadBefore(now - HOUR);
    expect(removed).toBe(1);
    expect(await repo.findInviteById(expired.id)).toBeNull();
    expect(await repo.findLiveSessionByTokenHash("expired-sess")).toBeNull();
    // The live invite is untouched.
    expect(await repo.findInviteById(live.id)).not.toBeNull();
  });
});
