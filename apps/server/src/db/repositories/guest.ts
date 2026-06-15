import {
  type GuestInvite,
  type GuestSession,
  pgSchema,
  sqliteSchema,
} from "@canvas-drop/shared/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

export interface CreateInviteInput {
  canvasId: string;
  email: string;
  /** Hash of the magic-link token (never the plaintext). */
  tokenHash: string;
  expiresAt: number | null;
}

export interface CreateGuestSessionInput {
  inviteId: string;
  canvasId: string;
  tokenHash: string;
  expiresAt: number;
}

/**
 * Guest invites + sessions repository (D4 email-invited guests, U6). Tokens are
 * stored hashed (the auth layer hashes before calling). Dual-dialect seam typed
 * `any` like the other repos; row shapes stay typed.
 */
export function guestRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const invites = client.dialect === "sqlite" ? sqliteSchema.guestInvites : pgSchema.guestInvites;
  const sessions =
    client.dialect === "sqlite" ? sqliteSchema.guestSessions : pgSchema.guestSessions;

  return {
    /**
     * Create (or replace) the invite for (canvas, email). Re-inviting the same
     * email mints a fresh token and resets state to pending — atomic upsert on the
     * unique (canvas_id, email) index, so a concurrent re-invite can't crash.
     */
    async createInvite(input: CreateInviteInput): Promise<GuestInvite> {
      const rows = await db
        .insert(invites)
        .values({
          id: uuidv7(),
          canvasId: input.canvasId,
          email: input.email,
          tokenHash: input.tokenHash,
          state: "pending",
          expiresAt: input.expiresAt,
          consumedAt: null,
          createdAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: [invites.canvasId, invites.email],
          set: {
            tokenHash: input.tokenHash,
            state: "pending",
            expiresAt: input.expiresAt,
            consumedAt: null,
            createdAt: Date.now(),
          },
        })
        .returning();
      return rows[0] as GuestInvite;
    },

    async findInviteByTokenHash(tokenHash: string): Promise<GuestInvite | null> {
      const rows = await db.select().from(invites).where(eq(invites.tokenHash, tokenHash)).limit(1);
      return (rows[0] as GuestInvite | undefined) ?? null;
    },

    async findInviteById(id: string): Promise<GuestInvite | null> {
      const rows = await db.select().from(invites).where(eq(invites.id, id)).limit(1);
      return (rows[0] as GuestInvite | undefined) ?? null;
    },

    async listInvitesByCanvas(canvasId: string): Promise<GuestInvite[]> {
      return (await db
        .select()
        .from(invites)
        .where(eq(invites.canvasId, canvasId))
        .orderBy(invites.createdAt)) as GuestInvite[];
    },

    /** Mark an invite consumed (pending → active) on first magic-link use. */
    async markConsumed(inviteId: string): Promise<void> {
      await db
        .update(invites)
        .set({ state: "active", consumedAt: Date.now() })
        .where(eq(invites.id, inviteId));
    },

    /**
     * Revoke the invite for (canvas, email) and all its sessions. Returns the
     * affected invite ids so the caller can drop live sockets.
     */
    async revokeInvite(canvasId: string, email: string): Promise<void> {
      const rows = (await db
        .update(invites)
        .set({ state: "revoked" })
        .where(and(eq(invites.canvasId, canvasId), eq(invites.email, email)))
        .returning({ id: invites.id })) as Array<{ id: string }>;
      for (const r of rows) await this.revokeSessionsForInvite(r.id);
    },

    /** Revoke every invite + session for a canvas (unpublish/archive cleanup, U8). */
    async revokeAllForCanvas(canvasId: string): Promise<void> {
      await db.update(invites).set({ state: "revoked" }).where(eq(invites.canvasId, canvasId));
      await db
        .update(sessions)
        .set({ revokedAt: Date.now() })
        .where(and(eq(sessions.canvasId, canvasId), isNull(sessions.revokedAt)));
    },

    async createSession(input: CreateGuestSessionInput): Promise<GuestSession> {
      const rows = await db
        .insert(sessions)
        .values({
          id: uuidv7(),
          inviteId: input.inviteId,
          canvasId: input.canvasId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          revokedAt: null,
          createdAt: Date.now(),
        })
        .returning();
      return rows[0] as GuestSession;
    },

    /** Live = exists, not revoked, not expired. */
    async findLiveSessionByTokenHash(
      tokenHash: string,
      now: number = Date.now(),
    ): Promise<GuestSession | null> {
      const rows = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, now),
          ),
        )
        .limit(1);
      return (rows[0] as GuestSession | undefined) ?? null;
    },

    async touchSessionExpiry(tokenHash: string, expiresAt: number): Promise<void> {
      await db.update(sessions).set({ expiresAt }).where(eq(sessions.tokenHash, tokenHash));
    },

    async revokeSessionsForInvite(inviteId: string): Promise<void> {
      await db
        .update(sessions)
        .set({ revokedAt: Date.now() })
        .where(and(eq(sessions.inviteId, inviteId), isNull(sessions.revokedAt)));
    },
  };
}

export type GuestRepository = ReturnType<typeof guestRepository>;
