import { createHash, randomBytes } from "node:crypto";
import { pgSchema, type Session, sqliteSchema } from "@canvas-drop/shared/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

/** SHA-256 hex of a high-entropy token — only the hash is ever stored (§12.1.3). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Generate a high-entropy opaque session token (URL-safe). */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface CreateSessionInput {
  userId: string;
  /** Raw token; only its hash is persisted. */
  token: string;
  expiresAt: number;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Sessions repository (oidc/dev app-managed sessions, KTD-5). Postgres `proxy`
 * mode is sessionless — the IAP owns the session.
 *
 * Dual-dialect seam typed `any` as in {@link usersRepository}; row shape stays
 * {@link Session}.
 */
export function sessionsRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.sessions : pgSchema.sessions;

  return {
    async create(input: CreateSessionInput): Promise<Session> {
      const inserted = await db
        .insert(t)
        .values({
          id: uuidv7(),
          userId: input.userId,
          tokenHash: hashToken(input.token),
          createdAt: Date.now(),
          expiresAt: input.expiresAt,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          revokedAt: null,
        })
        .returning();
      return inserted[0] as Session;
    },

    /** Live = exists, not revoked, not expired. */
    async findLiveByToken(token: string, now: number = Date.now()): Promise<Session | null> {
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.tokenHash, hashToken(token)), isNull(t.revokedAt), gt(t.expiresAt, now)))
        .limit(1);
      return (rows[0] as Session | undefined) ?? null;
    },

    async revokeByToken(token: string): Promise<void> {
      await db
        .update(t)
        .set({ revokedAt: Date.now() })
        .where(eq(t.tokenHash, hashToken(token)));
    },

    async revokeAllForUser(userId: string): Promise<void> {
      await db
        .update(t)
        .set({ revokedAt: Date.now() })
        .where(and(eq(t.userId, userId), isNull(t.revokedAt)));
    },

    /** Roll the rolling-expiry forward (called on authenticated use). */
    async touchExpiry(token: string, expiresAt: number): Promise<void> {
      await db
        .update(t)
        .set({ expiresAt })
        .where(eq(t.tokenHash, hashToken(token)));
    },
  };
}

export type SessionsRepository = ReturnType<typeof sessionsRepository>;
