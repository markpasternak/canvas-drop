import { type OrgMember, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";
import type { UserSearchResult } from "./users.js";

function escapedLikePattern(q: string): string {
  return `%${q
    .trim()
    .toLowerCase()
    .replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Explicit org-membership store (plan 003 P2 / U2, KTD1). In P1 membership was purely
 * DERIVED from the verified email domain; here we MATERIALIZE it as a row at login so
 * it's a join target for the team roster + reconciliation. The real-time auth boundary
 * still comes from the LIVE resolver (`principal.orgIds`, re-resolved each request from
 * the current domain config), so a stale row never widens access — {@link reconcile}
 * (U2) only keeps this table tidy. `source='domain'` is the only source written in P2.
 */
export function orgMembersRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const schema = client.dialect === "sqlite" ? sqliteSchema : pgSchema;
  const t = schema.orgMembers;
  const usersT = schema.users;

  return {
    /** Idempotent: materialize a `source='domain'` membership row (no-op if present). */
    async upsertDomainMember(orgId: string, userId: string): Promise<void> {
      await db
        .insert(t)
        .values({
          id: uuidv7(),
          orgId,
          userId,
          role: "member",
          source: "domain",
          createdAt: Date.now(),
        })
        .onConflictDoNothing();
    },

    /** Org ids the user has a materialized membership row for (roster/reconcile use). */
    async listOrgIdsForUser(userId: string): Promise<Set<string>> {
      const rows = (await db
        .select({ orgId: t.orgId })
        .from(t)
        .where(eq(t.userId, userId))) as Array<{ orgId: string }>;
      return new Set(rows.map((r) => r.orgId));
    },

    /** Whether the user has a materialized membership row for this org. */
    async isMember(orgId: string, userId: string): Promise<boolean> {
      const rows = (await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.orgId, orgId), eq(t.userId, userId)))
        .limit(1)) as Array<{ id: string }>;
      return rows.length > 0;
    },

    /** Search live, signed-in members of one org by name/email for Add person suggestions. */
    async searchMembers(orgId: string, q: string, limit = 8): Promise<UserSearchResult[]> {
      const pattern = escapedLikePattern(q);
      return (await db
        .select({ id: usersT.id, email: usersT.email, name: usersT.name })
        .from(t)
        .innerJoin(usersT, eq(t.userId, usersT.id))
        .where(
          and(
            eq(t.orgId, orgId),
            eq(usersT.isBlocked, false),
            sql`(lower(${usersT.name}) like ${pattern} escape '\\' or lower(${usersT.email}) like ${pattern} escape '\\')`,
          ),
        )
        .orderBy(sql`lower(${usersT.email}) asc`, desc(usersT.id))
        .limit(limit)) as UserSearchResult[];
    },

    /** Every materialized membership row (the reconcile sweep scans these). */
    async listAll(): Promise<OrgMember[]> {
      return (await db.select().from(t)) as OrgMember[];
    },

    /** Remove one materialized membership (reconcile revoke). */
    async remove(orgId: string, userId: string): Promise<void> {
      await db.delete(t).where(and(eq(t.orgId, orgId), eq(t.userId, userId)));
    },
  };
}

export type OrgMembersRepository = ReturnType<typeof orgMembersRepository>;
