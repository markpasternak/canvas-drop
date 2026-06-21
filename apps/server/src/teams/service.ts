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
  /** Can the actor even SEE this team exists (else opaque NOT-FOUND, §12.0)? An ORG team is
   *  visible to any member of its org (and operators); a PERSONAL team (org_id null) is
   *  visible to its creator (and operators) — its membership is the boundary, so a stranger
   *  must not learn it exists. Cross-org/foreign personal teams read as not-found, never a
   *  403-vs-404 existence leak. */
  function visible(actor: TeamActor, team: Team): boolean {
    if (actor.isAdmin) return true;
    if (team.orgId === null) return team.createdBy === actor.id;
    return actor.orgIds.has(team.orgId);
  }

  /** Load a team + assert the actor may MANAGE it (creator or operator). */
  async function manageable(actor: TeamActor, teamId: string): Promise<TeamResult> {
    const team = await deps.teams.findById(teamId);
    if (!team || !visible(actor, team)) return { ok: false, error: "TEAM_NOT_FOUND" };
    if (!actor.isAdmin && team.createdBy !== actor.id) return { ok: false, error: "FORBIDDEN" };
    return { ok: true, team };
  }

  return {
    /** Create a team (plan 003 phase 3): PERSONAL when `orgId` is omitted/null (any signed-in
     *  actor, incl. a no-org user — friends & family); ORG-attached when an `orgId` the actor
     *  is a live member of is supplied. Names are creator-local: the same actor can't make two
     *  teams with one name (in the same org-or-personal namespace), but different actors can. */
    async create(
      actor: TeamActor,
      input: { orgId?: string | null; name: string },
    ): Promise<TeamResult> {
      const orgId = input.orgId ?? null;
      // An org-attached team requires live membership of that org; a personal team (null) is
      // open to any signed-in actor.
      if (orgId !== null && !actor.orgIds.has(orgId)) return { ok: false, error: "NOT_A_MEMBER" };
      if (await deps.teams.nameTakenByCreator(orgId, actor.id, input.name))
        return { ok: false, error: "TEAM_NAME_TAKEN" };
      const team = await deps.teams.create({
        orgId,
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

    /** Add a member to a team. Actor must be a team member (self-serve) or operator. For an
     *  ORG team the target must be a same-org member (KTD3); for a PERSONAL team the target may
     *  be ANY existing user (plan 003 — friends & family). Inviting a not-yet-existing user via
     *  a pending invitation is the invite-primitive's job (later unit); here the target must
     *  already exist. */
    async addMemberByEmail(actor: TeamActor, teamId: string, email: string): Promise<VoidResult> {
      const team = await deps.teams.findById(teamId);
      if (!team || !visible(actor, team)) return { ok: false, error: "TEAM_NOT_FOUND" };
      if (!actor.isAdmin && !(await deps.teams.isTeamMember(teamId, actor.id)))
        return { ok: false, error: "FORBIDDEN" };
      const target = await deps.users.findByEmail(email.trim().toLowerCase());
      if (!target) return { ok: false, error: "TARGET_NOT_FOUND" };
      // Org team → same-org only; personal team → any existing user.
      if (team.orgId !== null && !(await deps.orgMembers.isMember(team.orgId, target.id)))
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
