import {
  type GuestInvite,
  type GuestSession,
  pgSchema,
  sqliteSchema,
} from "@canvas-drop/shared/db";
import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

export interface CreateInviteInput {
  canvasId: string;
  email: string;
  /** Hash of the retained legacy token (never the plaintext). */
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
 * Retained legacy guest invites + sessions repository. New owner sharing no longer
 * creates these rows; the repository remains for cutover, revocation, and retention.
 * Tokens are stored hashed (the auth layer hashes before calling). Dual-dialect seam
 * typed `any` like the other repos; row shapes stay typed.
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

    /** All non-revoked legacy invites, used by the auth-delegated cutover. */
    async listNonRevokedInvites(): Promise<GuestInvite[]> {
      return (await db
        .select()
        .from(invites)
        .where(ne(invites.state, "revoked"))
        .orderBy(invites.createdAt)) as GuestInvite[];
    },

    /**
     * Mark an invite consumed (pending → active) on first retained-token use. Atomic
     * compare-and-swap on `state='pending'` so two concurrent consumes can't both
     * mint a session from one single-use token — only the row that actually flips
     * returns true (KTD: no read-then-write TOCTOU on a single-use credential).
     */
    async markConsumed(inviteId: string): Promise<boolean> {
      const rows = (await db
        .update(invites)
        .set({ state: "active", consumedAt: Date.now() })
        .where(and(eq(invites.id, inviteId), eq(invites.state, "pending")))
        .returning({ id: invites.id })) as Array<{ id: string }>;
      return rows.length > 0;
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

    /** Retire every legacy credential while keeping rows for retention/backups. */
    async revokeAllInvitesAndSessions(): Promise<void> {
      const now = Date.now();
      await db.update(invites).set({ state: "revoked" }).where(ne(invites.state, "revoked"));
      await db.update(sessions).set({ revokedAt: now }).where(isNull(sessions.revokedAt));
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

    async listLiveSessions(now: number = Date.now()): Promise<GuestSession[]> {
      return (await db
        .select()
        .from(sessions)
        .where(and(isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))) as GuestSession[];
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

    /**
     * Retention prune (KTD-7): hard-delete dead legacy guest invites (and their sessions)
     * older than `cutoffMs`. Guest invites store an email address (PII), so a
     * revoked or long-expired invite is dead weight to discard per the privacy
     * policy. "Dead" = revoked, or expired before the cutoff; a still-active or
     * still-pending-and-unexpired invite is never touched. Sessions reference
     * invites via FK with no cascade, so the invites' sessions are deleted first.
     * Returns the number of invite rows removed.
     */
    async pruneDeadBefore(cutoffMs: number): Promise<number> {
      // Revoked invites carry no revoked-at clock, so gate them by createdAt;
      // expired invites by their own expiry. Pending-or-active live invites stay.
      const deadCond = or(
        and(eq(invites.state, "revoked"), lt(invites.createdAt, cutoffMs)),
        and(isNotNull(invites.expiresAt), lt(invites.expiresAt, cutoffMs)),
      );
      const dead = (await db.select({ id: invites.id }).from(invites).where(deadCond)) as Array<{
        id: string;
      }>;
      if (dead.length === 0) return 0;
      const deadIds = dead.map((r) => r.id);
      // Drop the dependent sessions first (FK on invite_id, no cascade), then the
      // invite rows themselves.
      await db.delete(sessions).where(inArray(sessions.inviteId, deadIds));
      await db.delete(invites).where(inArray(invites.id, deadIds));
      return dead.length;
    },
  };
}

export type GuestRepository = ReturnType<typeof guestRepository>;
