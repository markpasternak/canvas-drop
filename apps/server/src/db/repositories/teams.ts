import { orgSlug } from "@canvas-drop/shared";
import { pgSchema, sqliteSchema, type Team, type TeamMember } from "@canvas-drop/shared/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

/**
 * Teams store (plan 003 P2 / U3, KTD3/KTD4). Members-only groups inside one org, plus
 * the canvas→team grants (`canvas_teams`) that back the `team` access rung. Dual-dialect
 * seam typed `any` like the sibling repos; rows stay typed.
 *
 * The auth-critical method is {@link teamMatch}: it answers "may this principal reach this
 * `team` canvas?" by re-joining the LIVE org membership (`viewerOrgIds` from the principal,
 * not a materialized table), so a user removed from the org is denied immediately even if a
 * stale `team_members` row lingers (KTD3).
 */
export function teamsRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const S = client.dialect === "sqlite" ? sqliteSchema : pgSchema;
  const teamsT = S.teams;
  const membersT = S.teamMembers;
  const canvasTeamsT = S.canvasTeams;

  /** A slug unique within the org: orgSlug(name), else `<base>-2`, `-3`, … */
  async function freeSlug(orgId: string, name: string): Promise<string> {
    const base = orgSlug(name);
    const taken = new Set(
      (
        (await db
          .select({ slug: teamsT.slug })
          .from(teamsT)
          .where(eq(teamsT.orgId, orgId))) as Array<{ slug: string }>
      ).map((r) => r.slug),
    );
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  return {
    async create(input: { orgId: string; name: string; createdBy: string }): Promise<Team> {
      const slug = await freeSlug(input.orgId, input.name);
      const now = Date.now();
      const id = uuidv7();
      const rows = await db
        .insert(teamsT)
        .values({
          id,
          orgId: input.orgId,
          name: input.name,
          slug,
          createdBy: input.createdBy,
          createdAt: now,
        })
        .returning();
      // The creator is implicitly the first member.
      await db
        .insert(membersT)
        .values({
          id: uuidv7(),
          teamId: id,
          userId: input.createdBy,
          role: "member",
          createdAt: now,
        })
        .onConflictDoNothing();
      return rows[0] as Team;
    },

    async findById(id: string): Promise<Team | null> {
      const rows = (await db.select().from(teamsT).where(eq(teamsT.id, id)).limit(1)) as Team[];
      return rows[0] ?? null;
    },

    /**
     * Has this creator already made a team with this name in this org? Teams are
     * creator-local for naming (plan 003): a user can't have two teams with the same
     * name, but DIFFERENT users may each have a team of the same name. Case-insensitive,
     * on the trimmed name. (The slug stays org-unique via {@link freeSlug}; this guards
     * the human-facing name a creator sees.)
     */
    async nameTakenByCreator(orgId: string, createdBy: string, name: string): Promise<boolean> {
      const rows = (await db
        .select({ id: teamsT.id })
        .from(teamsT)
        .where(
          and(
            eq(teamsT.orgId, orgId),
            eq(teamsT.createdBy, createdBy),
            eq(sql`lower(${teamsT.name})`, name.trim().toLowerCase()),
          ),
        )
        .limit(1)) as Array<{ id: string }>;
      return rows.length > 0;
    },

    async rename(id: string, name: string): Promise<void> {
      await db.update(teamsT).set({ name }).where(eq(teamsT.id, id));
    },

    /** Delete a team + its memberships + its canvas grants (the team no longer scopes anything). */
    async remove(id: string): Promise<void> {
      await db.delete(canvasTeamsT).where(eq(canvasTeamsT.teamId, id));
      await db.delete(membersT).where(eq(membersT.teamId, id));
      await db.delete(teamsT).where(eq(teamsT.id, id));
    },

    /** Teams in an org (roster/admin). */
    async listByOrg(orgId: string): Promise<Team[]> {
      return (await db
        .select()
        .from(teamsT)
        .where(eq(teamsT.orgId, orgId))
        .orderBy(teamsT.createdAt)) as Team[];
    },

    /** Teams the user is a member of (the share picker + "my teams" view). The join
     *  projects under `team`, so unwrap to a flat `Team[]` — callers (the `/api/teams`
     *  `mine` flag, MCP `list_teams`) read `t.id` directly, not `t.team.id`. */
    async listForUser(userId: string): Promise<Team[]> {
      const rows = (await db
        .select({ team: teamsT })
        .from(membersT)
        .innerJoin(teamsT, eq(membersT.teamId, teamsT.id))
        .where(eq(membersT.userId, userId))
        .orderBy(teamsT.createdAt)) as Array<{ team: Team }>;
      return rows.map((r) => r.team);
    },

    async getMembers(teamId: string): Promise<TeamMember[]> {
      return (await db.select().from(membersT).where(eq(membersT.teamId, teamId))) as TeamMember[];
    },

    async isTeamMember(teamId: string, userId: string): Promise<boolean> {
      const rows = (await db
        .select({ id: membersT.id })
        .from(membersT)
        .where(and(eq(membersT.teamId, teamId), eq(membersT.userId, userId)))
        .limit(1)) as Array<{ id: string }>;
      return rows.length > 0;
    },

    async addMember(teamId: string, userId: string): Promise<void> {
      await db
        .insert(membersT)
        .values({ id: uuidv7(), teamId, userId, role: "member", createdAt: Date.now() })
        .onConflictDoNothing();
    },

    async removeMember(teamId: string, userId: string): Promise<void> {
      await db
        .delete(membersT)
        .where(and(eq(membersT.teamId, teamId), eq(membersT.userId, userId)));
    },

    // ---- canvas → team grants (the `team` rung; consumed by U4) ----

    /** Replace a canvas's granted teams with exactly `teamIds` (idempotent set semantics). */
    async setCanvasTeams(canvasId: string, teamIds: string[]): Promise<void> {
      await db.delete(canvasTeamsT).where(eq(canvasTeamsT.canvasId, canvasId));
      if (teamIds.length === 0) return;
      const now = Date.now();
      await db
        .insert(canvasTeamsT)
        .values(teamIds.map((teamId) => ({ canvasId, teamId, createdAt: now })))
        .onConflictDoNothing();
    },

    async listTeamIdsForCanvas(canvasId: string): Promise<string[]> {
      const rows = (await db
        .select({ teamId: canvasTeamsT.teamId })
        .from(canvasTeamsT)
        .where(eq(canvasTeamsT.canvasId, canvasId))) as Array<{ teamId: string }>;
      return rows.map((r) => r.teamId);
    },

    /**
     * Auth-critical (KTD3/KTD4): may `userId` (whose LIVE org membership is `viewerOrgIds`)
     * reach this `team` canvas? True iff some team granted to the canvas has the user as a
     * member AND lives in an org the user currently belongs to. The org re-join uses the
     * live `viewerOrgIds`, so a removed-from-org user is denied even with a stale team row.
     */
    async teamMatch(canvasId: string, userId: string, viewerOrgIds: Set<string>): Promise<boolean> {
      if (viewerOrgIds.size === 0) return false;
      const rows = (await db
        .select({ one: sql`1` })
        .from(canvasTeamsT)
        .innerJoin(membersT, eq(membersT.teamId, canvasTeamsT.teamId))
        .innerJoin(teamsT, eq(teamsT.id, canvasTeamsT.teamId))
        .where(
          and(
            eq(canvasTeamsT.canvasId, canvasId),
            eq(membersT.userId, userId),
            inArray(teamsT.orgId, [...viewerOrgIds]),
          ),
        )
        .limit(1)) as Array<unknown>;
      return rows.length > 0;
    },

    /** Canvases scoped to a team the user belongs to (the "shared with my teams" view, U5). */
    async listCanvasIdsForUserTeams(userId: string, viewerOrgIds: Set<string>): Promise<string[]> {
      if (viewerOrgIds.size === 0) return [];
      const rows = (await db
        .selectDistinct({ canvasId: canvasTeamsT.canvasId })
        .from(canvasTeamsT)
        .innerJoin(membersT, eq(membersT.teamId, canvasTeamsT.teamId))
        .innerJoin(teamsT, eq(teamsT.id, canvasTeamsT.teamId))
        .where(
          and(eq(membersT.userId, userId), inArray(teamsT.orgId, [...viewerOrgIds])),
        )) as Array<{
        canvasId: string;
      }>;
      return rows.map((r) => r.canvasId);
    },
  };
}

export type TeamsRepository = ReturnType<typeof teamsRepository>;
