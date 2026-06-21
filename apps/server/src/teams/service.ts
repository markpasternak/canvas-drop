import type { Team } from "@canvas-drop/shared/db";
import type { AuditLog } from "../audit/audit-log.js";
import type { OrgMembersRepository } from "../db/repositories/org-members.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UsersRepository } from "../db/repositories/users.js";

/**
 * Team service (plan 003 P2 / U3). The single authz-bearing layer the management routes
 * AND the MCP tools wrap (agent-native parity), so the rules live in one place:
 *  - create: any **member** of the org (self-serve, D6).
 *  - rename/delete: the team **creator** or an instance **operator** (admin) — flat roles (KTD5).
 *  - add/remove member: any team member (self-serve invite) or operator; the TARGET must be a
 *    same-org member (KTD3 write check; the read-time `teamMatch` re-join is the real guarantee).
 *
 * The acting principal's `orgIds` is the LIVE server-resolved membership — never client input.
 */
export type TeamError =
  | "NOT_A_MEMBER"
  | "TEAM_NOT_FOUND"
  | "TEAM_NAME_TAKEN"
  | "FORBIDDEN"
  | "TARGET_NOT_FOUND"
  | "TARGET_NOT_MEMBER";

export interface TeamActor {
  id: string;
  isAdmin: boolean;
  orgIds: Set<string>;
}

type Fail = { ok: false; error: TeamError };
type TeamResult = { ok: true; team: Team } | Fail;
type VoidResult = { ok: true } | Fail;

export function teamsService(deps: {
  teams: TeamsRepository;
  orgMembers: Pick<OrgMembersRepository, "isMember">;
  users: Pick<UsersRepository, "findByEmail">;
  audit: Pick<AuditLog, "recordAudit">;
}) {
  /** A team outside the actor's org(s) must read as NOT-FOUND, never FORBIDDEN — else the
   *  403-vs-404 split leaks the existence of teams in other orgs (§12.0 opacity). Operators
   *  (`isAdmin`) keep cross-org reach (their power lives on the admin surface). */
  function visible(actor: TeamActor, team: Team): boolean {
    return actor.isAdmin || actor.orgIds.has(team.orgId);
  }

  /** Load a team + assert the actor may MANAGE it (creator or operator). */
  async function manageable(actor: TeamActor, teamId: string): Promise<TeamResult> {
    const team = await deps.teams.findById(teamId);
    if (!team || !visible(actor, team)) return { ok: false, error: "TEAM_NOT_FOUND" };
    if (!actor.isAdmin && team.createdBy !== actor.id) return { ok: false, error: "FORBIDDEN" };
    return { ok: true, team };
  }

  return {
    /** Create a team in an org the actor is a (live) member of. Names are creator-local:
     *  the same actor can't make two teams with one name, but different actors can. */
    async create(actor: TeamActor, input: { orgId: string; name: string }): Promise<TeamResult> {
      if (!actor.orgIds.has(input.orgId)) return { ok: false, error: "NOT_A_MEMBER" };
      if (await deps.teams.nameTakenByCreator(input.orgId, actor.id, input.name))
        return { ok: false, error: "TEAM_NAME_TAKEN" };
      const team = await deps.teams.create({
        orgId: input.orgId,
        name: input.name,
        createdBy: actor.id,
      });
      deps.audit.recordAudit({ action: "team_create", actorId: actor.id, targetId: team.id });
      return { ok: true, team };
    },

    async rename(actor: TeamActor, teamId: string, name: string): Promise<TeamResult> {
      const m = await manageable(actor, teamId);
      if (!m.ok) return m;
      await deps.teams.rename(teamId, name);
      deps.audit.recordAudit({ action: "team_rename", actorId: actor.id, targetId: teamId });
      return { ok: true, team: { ...m.team, name } };
    },

    async remove(actor: TeamActor, teamId: string): Promise<VoidResult> {
      const m = await manageable(actor, teamId);
      if (!m.ok) return m;
      await deps.teams.remove(teamId);
      deps.audit.recordAudit({ action: "team_delete", actorId: actor.id, targetId: teamId });
      return { ok: true };
    },

    /** Add a same-org member to a team. Actor must be a team member (self-serve) or operator. */
    async addMemberByEmail(actor: TeamActor, teamId: string, email: string): Promise<VoidResult> {
      const team = await deps.teams.findById(teamId);
      if (!team || !visible(actor, team)) return { ok: false, error: "TEAM_NOT_FOUND" };
      if (!actor.isAdmin && !(await deps.teams.isTeamMember(teamId, actor.id)))
        return { ok: false, error: "FORBIDDEN" };
      const target = await deps.users.findByEmail(email.trim().toLowerCase());
      if (!target) return { ok: false, error: "TARGET_NOT_FOUND" };
      // The target must be a (materialized) member of the team's org — same-org only (KTD3).
      if (!(await deps.orgMembers.isMember(team.orgId, target.id)))
        return { ok: false, error: "TARGET_NOT_MEMBER" };
      await deps.teams.addMember(teamId, target.id);
      deps.audit.recordAudit({ action: "team_member_add", actorId: actor.id, targetId: teamId });
      return { ok: true };
    },

    /** Remove a member. A team member or operator may remove anyone; anyone may remove self. */
    async removeMember(
      actor: TeamActor,
      teamId: string,
      targetUserId: string,
    ): Promise<VoidResult> {
      const team = await deps.teams.findById(teamId);
      if (!team || !visible(actor, team)) return { ok: false, error: "TEAM_NOT_FOUND" };
      const selfLeave = targetUserId === actor.id;
      if (!selfLeave && !actor.isAdmin && !(await deps.teams.isTeamMember(teamId, actor.id)))
        return { ok: false, error: "FORBIDDEN" };
      await deps.teams.removeMember(teamId, targetUserId);
      deps.audit.recordAudit({ action: "team_member_remove", actorId: actor.id, targetId: teamId });
      return { ok: true };
    },
  };
}

export type TeamsService = ReturnType<typeof teamsService>;
