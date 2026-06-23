import type { Team } from "@canvas-drop/shared/db";
import type { AuditLog } from "../audit/audit-log.js";
import type { OrgMembersRepository } from "../db/repositories/org-members.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { InviteEmailDelivery, InviteService } from "../invites/service.js";

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
  | "TARGET_NOT_MEMBER"
  | "TARGET_NOT_PERMITTED"
  | "TARGET_BLOCKED"
  | "AUTH_ADMISSION_REQUIRED"
  | "RATE_LIMITED";

export interface TeamActor {
  id: string;
  isAdmin: boolean;
  orgIds: Set<string>;
  /** The actor's display name + email — needed to mint an InviteActor for personal-team
   *  invites (the courtesy email's inviter + the audited invited_by). */
  name: string;
  email: string;
}

type Fail = { ok: false; error: TeamError };
type TeamResult = { ok: true; team: Team } | Fail;
type VoidResult = { ok: true } | Fail;
/** add-member can grant now, no-op idempotently, or record pending access. */
type AddMemberResult =
  | {
      ok: true;
      status: "granted" | "already_added" | "pending" | "already_pending";
      emailDelivery?: InviteEmailDelivery;
    }
  | Fail;

export function teamsService(deps: {
  teams: TeamsRepository;
  orgMembers: Pick<OrgMembersRepository, "isMember">;
  users: Pick<UsersRepository, "findByEmail">;
  /** The Add person primitive (plan 003 U5) — personal-team adds route through it so a
   *  brand-new email becomes pending access (KTD5-gated) instead of TARGET_NOT_FOUND. */
  invites: InviteService;
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

    /** Add a member to a team. Actor must be a team member (self-serve) or operator.
     *
     *  ORG team (KTD3): the target must be an EXISTING same-org member — strict, unchanged.
     *  Brand-new same-domain people are admitted via admin sign-in permits, not here.
     *
     *  PERSONAL team (plan 003 — friends & family): route through Add person (U5), so
     *  an existing user is granted now and a brand-new email becomes pending access
     *  (gated by KTD5: a self-serve actor can't permit a new external email). */
    async addMemberByEmail(
      actor: TeamActor,
      teamId: string,
      email: string,
    ): Promise<AddMemberResult> {
      const team = await deps.teams.findById(teamId);
      if (!team || !visible(actor, team)) return { ok: false, error: "TEAM_NOT_FOUND" };
      if (!actor.isAdmin && !(await deps.teams.isTeamMember(teamId, actor.id)))
        return { ok: false, error: "FORBIDDEN" };

      if (team.orgId !== null) {
        // Org team: existing same-org member only.
        const target = await deps.users.findByEmail(email.trim().toLowerCase());
        if (!target) return { ok: false, error: "TARGET_NOT_FOUND" };
        if (!(await deps.orgMembers.isMember(team.orgId, target.id)))
          return { ok: false, error: "TARGET_NOT_MEMBER" };
        if (await deps.teams.isTeamMember(teamId, target.id)) {
          return { ok: true, status: "already_added" };
        }
        await deps.teams.addMember(teamId, target.id);
        deps.audit.recordAudit({ action: "team_member_add", actorId: actor.id, targetId: teamId });
        return { ok: true, status: "granted" };
      }

      // Personal team: the invite primitive owns resolve / permit / grant-or-pending / notify.
      const r = await deps.invites.resolveOrInvite(
        { kind: "team", teamId, teamName: team.name },
        email,
        { id: actor.id, name: actor.name, email: actor.email, isAdmin: actor.isAdmin },
      );
      if (r.status === "policy_blocked") return { ok: false, error: "TARGET_NOT_PERMITTED" };
      if (r.status === "auth_admission_required")
        return { ok: false, error: "AUTH_ADMISSION_REQUIRED" };
      if (r.status === "blocked") return { ok: false, error: "TARGET_BLOCKED" };
      if (r.status === "rate_limited") return { ok: false, error: "RATE_LIMITED" };
      deps.audit.recordAudit({ action: "team_member_add", actorId: actor.id, targetId: teamId });
      return r.emailDelivery
        ? { ok: true, status: r.status, emailDelivery: r.emailDelivery }
        : { ok: true, status: r.status };
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
