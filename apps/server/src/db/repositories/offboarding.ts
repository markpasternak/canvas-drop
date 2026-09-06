import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbClient } from "../factory.js";
import { usersRepository } from "./users.js";

/** Administrative inventory only. No manifests, content, credentials, or usage payloads. */
export function offboardingRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect repository seam
  const db = client.db as any;
  const s = client.dialect === "sqlite" ? sqliteSchema : pgSchema;
  return {
    async organizationNames(ids: string[]): Promise<Array<{ id: string; name: string }>> {
      return ids.length
        ? await db
            .select({ id: s.orgs.id, name: s.orgs.name })
            .from(s.orgs)
            .where(inArray(s.orgs.id, ids))
            .orderBy(s.orgs.id)
        : [];
    },
    async inventory(email: string, userId?: string) {
      const owned = userId
        ? await db
            .select({
              id: s.canvases.id,
              title: s.canvases.title,
              slug: s.canvases.slug,
              orgId: s.canvases.orgId,
              status: s.canvases.status,
              access: s.canvases.access,
              updatedAt: s.canvases.updatedAt,
            })
            .from(s.canvases)
            .where(and(eq(s.canvases.ownerId, userId), isNull(s.canvases.purgeStartedAt)))
            .orderBy(s.canvases.id)
        : [];
      const direct = await db
        .select({
          id: s.canvasAllowlist.id,
          canvasId: s.canvasAllowlist.canvasId,
          title: s.canvases.title,
          role: s.canvasAllowlist.role,
        })
        .from(s.canvasAllowlist)
        .innerJoin(s.canvases, eq(s.canvases.id, s.canvasAllowlist.canvasId))
        .where(
          or(
            eq(s.canvasAllowlist.email, email),
            userId ? eq(s.canvasAllowlist.userId, userId) : undefined,
          ),
        )
        .orderBy(s.canvasAllowlist.id);
      const permits = await db
        .select({ id: s.allowedEmails.id })
        .from(s.allowedEmails)
        .where(eq(s.allowedEmails.email, email))
        .orderBy(s.allowedEmails.id);
      const createdTeams = userId
        ? await db
            .select({ id: s.teams.id, name: s.teams.name, orgId: s.teams.orgId })
            .from(s.teams)
            .where(eq(s.teams.createdBy, userId))
            .orderBy(s.teams.id)
        : [];
      return {
        owned: owned as Array<{
          id: string;
          title: string;
          slug: string;
          orgId: string | null;
          status: string;
          access: string;
          updatedAt: number;
        }>,
        direct: direct as Array<{ id: string; canvasId: string; title: string; role: string }>,
        permits: permits as Array<{ id: string }>,
        createdTeams: createdTeams as Array<{ id: string; name: string; orgId: string | null }>,
      };
    },
    async removeDirect(id: string, email: string, userId?: string): Promise<void> {
      await db
        .delete(s.canvasAllowlist)
        .where(
          and(
            eq(s.canvasAllowlist.id, id),
            or(
              eq(s.canvasAllowlist.email, email),
              userId ? eq(s.canvasAllowlist.userId, userId) : undefined,
            ),
          ),
        );
    },
    /** All remaining owner keys are revoked after attempted reassignment. Hashes
     * deliberately cannot match a valid API-key digest; new owners issue fresh keys. */
    async revokeRemainingOwnerKeys(userId: string): Promise<void> {
      await db
        .update(s.canvases)
        .set({
          apiKeyHash: sql`'offboarded:' || ${s.canvases.id}`,
          updatedAt: sql`${s.canvases.updatedAt} + 1`,
        })
        .where(and(eq(s.canvases.ownerId, userId), isNull(s.canvases.purgeStartedAt)));
    },
    /** Serialize admin-removing offboarding on PostgreSQL; SQLite's conditional
     * UPDATE is one atomic write. Recheck the actor too after waiting for locks. */
    async blockAccount(userId: string, actorId: string): Promise<"blocked" | "self" | "refused"> {
      if (userId === actorId) return "self";
      return (await usersRepository(client).removeAuthority(userId, "offboard", actorId))
        ? "blocked"
        : "refused";
    },
    async revokeLegacyGuestSessions(email: string): Promise<void> {
      const invites = await db
        .select({ id: s.guestInvites.id })
        .from(s.guestInvites)
        .where(eq(s.guestInvites.email, email));
      for (const invite of invites) {
        await db
          .update(s.guestInvites)
          .set({ state: "revoked" })
          .where(eq(s.guestInvites.id, invite.id));
        await db
          .update(s.guestSessions)
          .set({ revokedAt: Date.now() })
          .where(eq(s.guestSessions.inviteId, invite.id));
      }
    },
  };
}
export type OffboardingRepository = ReturnType<typeof offboardingRepository>;
