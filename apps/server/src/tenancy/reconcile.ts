import { domainOfEmail } from "@canvas-drop/shared";
import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../db/factory.js";
import type { OrgsRepository } from "../db/repositories/orgs.js";

/**
 * Membership reconciliation (plan 003 P2 / U2, KTD2). When the operator removes a domain
 * from `CANVAS_DROP_ORG_DOMAINS`, the boot materialization prunes `org_domains` — but the
 * MATERIALIZED `org_members` rows (and the `team_members` that hang off them) linger. This
 * sweep removes them: a `source='domain'` member whose verified email domain no longer maps
 * to that org is **stale**, so its `org_members` row is revoked AND its `team_members` rows
 * for that org's teams are cascade-revoked (else a now-outsider keeps team-canvas access —
 * a real leak, R13).
 *
 * The real-time auth boundary does NOT depend on this sweep — `principal.orgIds` is
 * re-resolved live from the current domain config each request, so a removed-domain user is
 * already denied on their next request. This keeps the materialized tables honest for the
 * roster + team-membership joins. Read-only `planReconcile` first; `applyReconcile` writes.
 *
 * Crosses the dual-dialect seam in one place (like cutover.ts); the schemas stay in lockstep.
 */

// biome-ignore lint/suspicious/noExplicitAny: single documented dual-dialect boundary
type AnyDb = any;

function tables(client: DbClient) {
  return client.dialect === "sqlite"
    ? {
        users: sqliteSchema.users,
        orgMembers: sqliteSchema.orgMembers,
        teams: sqliteSchema.teams,
        teamMembers: sqliteSchema.teamMembers,
      }
    : {
        users: pgSchema.users,
        orgMembers: pgSchema.orgMembers,
        teams: pgSchema.teams,
        teamMembers: pgSchema.teamMembers,
      };
}

interface StaleMember {
  userId: string;
  email: string;
  orgId: string;
  /** team_members rows (this user, teams of this org) that cascade-revoke with the member. */
  teamMemberIds: string[];
}

/** READ-ONLY: find materialized `org_members` whose user's domain no longer maps to that org. */
async function findStale(
  client: DbClient,
  orgs: Pick<OrgsRepository, "findByDomain">,
): Promise<StaleMember[]> {
  const db = client.db as AnyDb;
  const t = tables(client);

  const members = (await db
    .select({
      userId: t.orgMembers.userId,
      orgId: t.orgMembers.orgId,
      source: t.orgMembers.source,
      email: t.users.email,
    })
    .from(t.orgMembers)
    .innerJoin(t.users, eq(t.orgMembers.userId, t.users.id))) as Array<{
    userId: string;
    orgId: string;
    source: string;
    email: string;
  }>;

  const stale: StaleMember[] = [];
  for (const m of members) {
    if (m.source !== "domain") continue; // only the auto-materialized rows are reconciled
    const domain = domainOfEmail(m.email);
    const org = domain ? await orgs.findByDomain(domain) : null;
    if (org && org.id === m.orgId) continue; // still a valid member — leave it

    // Stale: collect the user's team_members for teams in this org (cascade targets).
    const teamRows = (await db
      .select({ id: t.teamMembers.id })
      .from(t.teamMembers)
      .innerJoin(t.teams, eq(t.teamMembers.teamId, t.teams.id))
      .where(and(eq(t.teamMembers.userId, m.userId), eq(t.teams.orgId, m.orgId)))) as Array<{
      id: string;
    }>;
    stale.push({
      userId: m.userId,
      email: m.email,
      orgId: m.orgId,
      teamMemberIds: teamRows.map((r) => r.id),
    });
  }
  return stale;
}

export interface ReconcilePlan {
  /** Members to revoke (email + org), with the team_members that cascade with each. */
  staleMembers: Array<{ userId: string; email: string; orgId: string }>;
  /** Total team_members rows that will be cascade-revoked. */
  cascadeTeamMembers: number;
}

/** READ-ONLY dry-run: classify stale memberships + the team rows that cascade. No writes. */
export async function planReconcile(
  client: DbClient,
  orgs: Pick<OrgsRepository, "findByDomain">,
): Promise<ReconcilePlan> {
  const stale = await findStale(client, orgs);
  return {
    staleMembers: stale.map(({ userId, email, orgId }) => ({ userId, email, orgId })),
    cascadeTeamMembers: stale.reduce((n, s) => n + s.teamMemberIds.length, 0),
  };
}

/** Revoke stale `org_members` rows and cascade their `team_members`. Idempotent. */
export async function applyReconcile(
  client: DbClient,
  orgs: Pick<OrgsRepository, "findByDomain">,
): Promise<{ revokedMembers: number; revokedTeamMembers: number }> {
  const db = client.db as AnyDb;
  const t = tables(client);
  const stale = await findStale(client, orgs);

  let revokedTeamMembers = 0;
  for (const s of stale) {
    if (s.teamMemberIds.length > 0) {
      await db.delete(t.teamMembers).where(inArray(t.teamMembers.id, s.teamMemberIds));
      revokedTeamMembers += s.teamMemberIds.length;
    }
    await db
      .delete(t.orgMembers)
      .where(and(eq(t.orgMembers.userId, s.userId), eq(t.orgMembers.orgId, s.orgId)));
  }
  return { revokedMembers: stale.length, revokedTeamMembers };
}
