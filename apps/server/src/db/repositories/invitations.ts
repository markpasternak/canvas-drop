import { type Invitation, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, count, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

/** A grant target — a team membership or a canvas allowlist entry to materialize on login. */
export type InvitationTarget = { type: "team"; id: string } | { type: "canvas"; id: string };

/** What `record` needs to persist pending access. */
export interface RecordInvitation {
  email: string; // already lowercased by the caller
  target: InvitationTarget;
  role?: string | null;
  invitedBy: string;
}

export interface MaterializeCanvasInvitation {
  invitationId: string;
  canvasId: string;
  userId: string;
  expectedRole: string | null;
  role: "viewer" | "editor";
  updateExistingRole: boolean;
}

export interface MaterializeTeamInvitation {
  invitationId: string;
  teamId: string;
  userId: string;
}

/**
 * Pending-access store (plan 003 phase 4 / U4). Pending access is a grant recorded
 * BEFORE the person has a `users` row. When the email first authenticates (verified by the
 * IdP/proxy — never client input), {@link materializePendingInvitations} applies each grant and
 * stamps `consumed_at`. `record` is idempotent on (email, target_type, target_id): a duplicate
 * pending access row is a no-op rather than a constraint crash.
 */
export function invitationsRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const S = client.dialect === "sqlite" ? sqliteSchema : pgSchema;
  const T = S.invitations;
  const allowlistT = S.canvasAllowlist;
  const teamMembersT = S.teamMembers;

  const canvasClaim = (input: MaterializeCanvasInvitation) =>
    and(
      eq(T.id, input.invitationId),
      eq(T.targetType, "canvas"),
      eq(T.targetId, input.canvasId),
      isNull(T.consumedAt),
      input.expectedRole === null ? isNull(T.role) : eq(T.role, input.expectedRole),
    );

  const teamClaim = (input: MaterializeTeamInvitation) =>
    and(
      eq(T.id, input.invitationId),
      eq(T.targetType, "team"),
      eq(T.targetId, input.teamId),
      isNull(T.consumedAt),
    );

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

    /** Whether a lowercased email already has an unconsumed invitation for this target. */
    async hasPendingForTarget(
      targetType: InvitationTarget["type"],
      targetId: string,
      email: string,
    ): Promise<boolean> {
      const rows = (await db
        .select({ id: T.id })
        .from(T)
        .where(
          and(
            eq(T.targetType, targetType),
            eq(T.targetId, targetId),
            eq(T.email, email.trim().toLowerCase()),
            isNull(T.consumedAt),
          ),
        )
        .limit(1)) as Array<{ id: string }>;
      return rows.length > 0;
    },

    /** One un-consumed invitation by id, scoped to its target (null when absent / consumed). */
    async findPendingForTarget(
      targetType: InvitationTarget["type"],
      targetId: string,
      id: string,
    ): Promise<Invitation | null> {
      const rows = (await db
        .select()
        .from(T)
        .where(
          and(
            eq(T.targetType, targetType),
            eq(T.targetId, targetId),
            eq(T.id, id),
            isNull(T.consumedAt),
          ),
        )
        .limit(1)) as Invitation[];
      return rows[0] ?? null;
    },

    /** Change a pending grant's role (editor-roles plan), scoped to its target. */
    async setPendingRole(
      targetType: InvitationTarget["type"],
      targetId: string,
      id: string,
      role: string,
    ): Promise<Invitation | null> {
      const rows = (await db
        .update(T)
        .set({ role })
        .where(
          and(
            eq(T.targetType, targetType),
            eq(T.targetId, targetId),
            eq(T.id, id),
            isNull(T.consumedAt),
          ),
        )
        .returning()) as Invitation[];
      return rows[0] ?? null;
    },

    /** Un-consumed invitations for a (lowercased) email — the apply set on first login. */
    async listForEmail(email: string): Promise<Invitation[]> {
      return (await db
        .select()
        .from(T)
        .where(and(eq(T.email, email), isNull(T.consumedAt)))) as Invitation[];
    },

    /**
     * Atomically claim a pending canvas invitation and materialize its member grant.
     * Cancellation and role changes race against the conditional claim, so neither can
     * leave behind a durable grant for an invitation they won. A failed insert rolls the
     * claim back, preserving the materializer's retry-on-next-login contract.
     */
    async materializeCanvasGrant(input: MaterializeCanvasInvitation): Promise<boolean> {
      const values = {
        id: uuidv7(),
        canvasId: input.canvasId,
        principalKind: "member",
        userId: input.userId,
        email: null,
        role: input.role,
        createdAt: Date.now(),
      } as const;
      const set = input.updateExistingRole ? { role: input.role } : { canvasId: input.canvasId };

      if (client.dialect === "sqlite") {
        return db.transaction((q: typeof db) => {
          const claimed = q
            .update(T)
            .set({ consumedAt: Date.now() })
            .where(canvasClaim(input))
            .returning({ id: T.id })
            .all() as Array<{ id: string }>;
          if (claimed.length === 0) return false;
          q.insert(allowlistT)
            .values(values)
            .onConflictDoUpdate({
              target: [allowlistT.canvasId, allowlistT.userId],
              set,
            })
            .run();
          return true;
        });
      }

      return db.transaction(async (q: typeof db) => {
        const claimed = (await q
          .update(T)
          .set({ consumedAt: Date.now() })
          .where(canvasClaim(input))
          .returning({ id: T.id })) as Array<{ id: string }>;
        if (claimed.length === 0) return false;
        await q
          .insert(allowlistT)
          .values(values)
          .onConflictDoUpdate({
            target: [allowlistT.canvasId, allowlistT.userId],
            set,
          });
        return true;
      });
    },

    /** Atomically claim a pending team invitation and materialize its membership. */
    async materializeTeamGrant(input: MaterializeTeamInvitation): Promise<boolean> {
      const values = {
        id: uuidv7(),
        teamId: input.teamId,
        userId: input.userId,
        role: "member",
        createdAt: Date.now(),
      } as const;

      if (client.dialect === "sqlite") {
        return db.transaction((q: typeof db) => {
          const claimed = q
            .update(T)
            .set({ consumedAt: Date.now() })
            .where(teamClaim(input))
            .returning({ id: T.id })
            .all() as Array<{ id: string }>;
          if (claimed.length === 0) return false;
          q.insert(teamMembersT).values(values).onConflictDoNothing().run();
          return true;
        });
      }

      return db.transaction(async (q: typeof db) => {
        const claimed = (await q
          .update(T)
          .set({ consumedAt: Date.now() })
          .where(teamClaim(input))
          .returning({ id: T.id })) as Array<{ id: string }>;
        if (claimed.length === 0) return false;
        await q.insert(teamMembersT).values(values).onConflictDoNothing();
        return true;
      });
    },

    /** Stamp an invitation consumed (idempotent — a no-op if already consumed). */
    async consume(id: string): Promise<void> {
      await db
        .update(T)
        .set({ consumedAt: Date.now() })
        .where(and(eq(T.id, id), isNull(T.consumedAt)));
    },

    /** One un-consumed invitation by id (the materializer's re-read after a lost race). */
    async findPendingById(id: string): Promise<Invitation | null> {
      const rows = (await db
        .select()
        .from(T)
        .where(and(eq(T.id, id), isNull(T.consumedAt)))
        .limit(1)) as Invitation[];
      return rows[0] ?? null;
    },

    /** Cancel an unconsumed pending grant for a specific target. Returns the deleted
     *  row (or null) so callers can audit WHO was uninvited — the row is hard-deleted,
     *  so the audit trail is the only place the email survives. */
    async cancelPendingForTarget(
      targetType: InvitationTarget["type"],
      targetId: string,
      id: string,
    ): Promise<Invitation | null> {
      const rows = (await db
        .delete(T)
        .where(
          and(
            eq(T.targetType, targetType),
            eq(T.targetId, targetId),
            eq(T.id, id),
            isNull(T.consumedAt),
          ),
        )
        .returning()) as Invitation[];
      return rows[0] ?? null;
    },

    /** Cancel any unconsumed pending grant by id, regardless of target. Admin People uses this. */
    async cancelPending(id: string): Promise<Invitation | null> {
      const rows = (await db
        .delete(T)
        .where(and(eq(T.id, id), isNull(T.consumedAt)))
        .returning()) as Invitation[];
      return rows[0] ?? null;
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
