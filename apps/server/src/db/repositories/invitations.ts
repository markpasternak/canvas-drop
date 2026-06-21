import { type Invitation, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, count, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

/** A grant target — a team membership or a canvas allowlist entry to materialize on login. */
export type InvitationTarget = { type: "team"; id: string } | { type: "canvas"; id: string };

/** What `record` needs to persist a pending invitation. */
export interface RecordInvitation {
  email: string; // already lowercased by the caller
  target: InvitationTarget;
  role?: string | null;
  invitedBy: string;
}

/**
 * Pending-invitations store (plan 003 phase 4 / U4). A pending invitation is a grant recorded
 * BEFORE the invitee has a `users` row. When the email first authenticates (verified by the
 * IdP/proxy — never client input), {@link materializePendingInvitations} applies each grant and
 * stamps `consumed_at`. `record` is idempotent on (email, target_type, target_id): a duplicate
 * pending invite is a no-op rather than a constraint crash.
 */
export function invitationsRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const T = (client.dialect === "sqlite" ? sqliteSchema : pgSchema).invitations;

  return {
    /** Record a pending grant (idempotent on the email+target unique index). */
    async record(input: RecordInvitation): Promise<void> {
      await db
        .insert(T)
        .values({
          id: uuidv7(),
          email: input.email,
          targetType: input.target.type,
          targetId: input.target.id,
          role: input.role ?? null,
          invitedBy: input.invitedBy,
          createdAt: Date.now(),
          consumedAt: null,
        })
        .onConflictDoNothing();
    },

    /** Un-consumed invitations for a target (e.g. a team's pending roster rows). */
    async listPendingForTarget(
      targetType: InvitationTarget["type"],
      targetId: string,
    ): Promise<Invitation[]> {
      return (await db
        .select()
        .from(T)
        .where(
          and(eq(T.targetType, targetType), eq(T.targetId, targetId), isNull(T.consumedAt)),
        )) as Invitation[];
    },

    /** Un-consumed invitations for a (lowercased) email — the apply set on first login. */
    async listForEmail(email: string): Promise<Invitation[]> {
      return (await db
        .select()
        .from(T)
        .where(and(eq(T.email, email), isNull(T.consumedAt)))) as Invitation[];
    },

    /** Stamp an invitation consumed (idempotent — a no-op if already consumed). */
    async consume(id: string): Promise<void> {
      await db
        .update(T)
        .set({ consumedAt: Date.now() })
        .where(and(eq(T.id, id), isNull(T.consumedAt)));
    },

    /** Count un-consumed invitations recorded by an actor (the KTD9 pending cap). */
    async countPendingByActor(invitedBy: string): Promise<number> {
      const rows = (await db
        .select({ n: count() })
        .from(T)
        .where(and(eq(T.invitedBy, invitedBy), isNull(T.consumedAt)))) as Array<{ n: number }>;
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type InvitationsRepository = ReturnType<typeof invitationsRepository>;
