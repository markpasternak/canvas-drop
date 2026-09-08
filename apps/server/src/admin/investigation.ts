import { type Config, parseRuntimePolicy } from "@canvas-drop/shared";
import { type CanvasStatus, publicationState } from "@canvas-drop/shared/db";
import { isEmailAllowed } from "../auth/identity-mapping.js";
import type { OrgMembershipResolver } from "../auth/org-membership.js";
import { decideCanvasAccess, resolveAccessContext } from "../canvas/authorization.js";
import { resolveManagementRole } from "../canvas/role.js";
import type { ConnectionService } from "../connections/service.js";
import type { AdminRepository } from "../db/repositories/admin.js";
import type { AllowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import type { AuditRepository } from "../db/repositories/audit.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { FilesRepository } from "../db/repositories/files.js";
import type { InvitationsRepository } from "../db/repositories/invitations.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { Principal } from "../http/types.js";
import { listAdminActivity } from "./activity.js";
import type { AdminSettingsService } from "./settings-service.js";

export interface InvestigationDeps {
  config: Config;
  canvases: CanvasesRepository;
  users: UsersRepository;
  allowedEmails: Pick<AllowedEmailsRepository, "isAllowed">;
  teams: TeamsRepository;
  invitations: InvitationsRepository;
  versions: VersionsRepository;
  files: FilesRepository;
  admin: AdminRepository;
  auditReader: AuditRepository;
  connections: ConnectionService;
  settings: AdminSettingsService;
  orgMembership?: OrgMembershipResolver;
}

export function adminInvestigation(deps: InvestigationDeps) {
  const tenancyActive = !!deps.config.org.name;
  const publicLinksEnabled = () => deps.settings.effectivePublicLinksEnabled();
  return {
    async inspect(id: string) {
      const canvas = await deps.canvases.findById(id);
      if (!canvas) return null;
      const [
        owner,
        direct,
        teamGrants,
        versions,
        fileBytes,
        usage,
        connections,
        activity,
        pending,
        publicEnabled,
      ] = await Promise.all([
        deps.users.findById(canvas.ownerId),
        deps.canvases.listAllowlist(id),
        deps.teams.listCanvasTeamGrants(id),
        deps.versions.listByCanvas(id),
        deps.files.bytesByCanvas([id]),
        deps.admin.usageCountByCanvas([id]),
        deps.connections.listForCanvas(id),
        listAdminActivity(deps.auditReader, { canvasId: id, limit: 10, offset: 0 }),
        deps.invitations.listPendingForTarget("canvas", id),
        publicLinksEnabled(),
      ]);
      const [people, teams] = await Promise.all([
        deps.users.findByIds(direct.flatMap((entry) => (entry.userId ? [entry.userId] : []))),
        deps.teams.findByIds(teamGrants.map((grant) => grant.teamId)),
      ]);
      const usersById = new Map(people.map((person) => [person.id, person]));
      const teamsById = new Map(teams.map((team) => [team.id, team]));
      const teamInvitations = await Promise.all(
        teams.map(async (team) => ({
          team,
          invitations: await deps.invitations.listPendingForTarget("team", team.id),
        })),
      );
      return {
        canvas: {
          id: canvas.id,
          title: canvas.title,
          slug: canvas.slug,
          ownerId: canvas.ownerId,
          orgId: canvas.orgId,
          status: canvas.status,
          publicationState: publicationState(
            canvas.status as CanvasStatus,
            canvas.currentVersionId !== null,
          ),
          access: canvas.access,
          hasPassword: canvas.passwordHash !== null,
          sharedExpiresAt: canvas.sharedExpiresAt,
          disabledReason: canvas.disabledReason,
          deletedAt: canvas.deletedAt,
          createdAt: canvas.createdAt,
          updatedAt: canvas.updatedAt,
          backendEnabled: canvas.backendEnabled,
          runtimePolicy: parseRuntimePolicy(canvas.runtimePolicy),
          aiAudience: canvas.aiAudience,
          connectionsAudience: canvas.connectionsAudience,
          publicLinkEffective:
            canvas.access === "public_link" &&
            publicEnabled &&
            owner?.canPublishPublic === true &&
            canvas.status === "active" &&
            canvas.currentVersionId !== null &&
            (canvas.sharedExpiresAt === null || canvas.sharedExpiresAt > Date.now()),
        },
        owner: owner
          ? {
              id: owner.id,
              name: owner.name,
              email: owner.email,
              blocked: owner.isBlocked,
              canPublishPublic: owner.canPublishPublic,
            }
          : null,
        people: direct.map((entry) => ({
          userId: entry.userId,
          email: entry.email ?? (entry.userId ? usersById.get(entry.userId)?.email : null) ?? null,
          role: entry.role,
          createdAt: entry.createdAt,
        })),
        teams: teamGrants.map((grant) => ({
          id: grant.teamId,
          name: teamsById.get(grant.teamId)?.name ?? "Removed team",
          role: grant.role,
        })),
        pending: [
          ...pending.map((invite) => ({
            id: invite.id,
            email: invite.email,
            role: invite.role,
            createdAt: invite.createdAt,
            via: "Direct invitation",
          })),
          ...teamInvitations.flatMap(({ team, invitations }) =>
            invitations.map((invite) => ({
              id: invite.id,
              email: invite.email,
              role: teamGrants.find((grant) => grant.teamId === team.id)?.role ?? "viewer",
              createdAt: invite.createdAt,
              via: `Team: ${team.name}`,
            })),
          ),
        ],
        usage: {
          operations: usage.get(id) ?? 0,
          uploadedFileBytes: fileBytes.get(id) ?? 0,
          versionCount: versions.length,
          deployedBytes: versions.find((v) => v.id === canvas.currentVersionId)?.totalBytes ?? 0,
        },
        connections,
        activity,
      };
    },

    async explainAccess(id: string, email?: string) {
      const canvas = await deps.canvases.findById(id);
      if (!canvas) return null;
      const user = email ? await deps.users.findByEmail(email) : null;
      const signInAllowed = user
        ? await isEmailAllowed(user.email, deps.config, deps.allowedEmails)
        : true;
      const orgIds = user
        ? await (deps.orgMembership?.(user) ?? Promise.resolve(new Set<string>()))
        : new Set<string>();
      const principal: Principal = user
        ? { kind: "member", id: user.id, isAdmin: user.isAdmin, orgIds }
        : { kind: "anonymous" };
      const [role, ctx, direct, userTeams, invitations] = await Promise.all([
        resolveManagementRole(canvas, principal, { canvases: deps.canvases, tenancyActive }),
        resolveAccessContext(deps.canvases, deps.teams, canvas, principal, {
          publicLinksEnabled,
          tenancyActive,
        }),
        user ? deps.canvases.findMemberEntry(id, user.id) : Promise.resolve(null),
        user ? deps.teams.listCanvasGrantsForUserTeams(user.id, orgIds) : Promise.resolve([]),
        email ? deps.invitations.listForEmail(email) : Promise.resolve([]),
      ]);
      const canvasTeams = await deps.teams.listCanvasTeamGrants(id);
      const teamIds = new Set(canvasTeams.map((team) => team.teamId));
      const pending = invitations.filter(
        (invite) =>
          invite.consumedAt === null &&
          (invite.targetType === "canvas" ? invite.targetId === id : teamIds.has(invite.targetId)),
      );
      const matchingTeams = userTeams.filter((grant) => grant.canvasId === id);
      const decision = decideCanvasAccess(canvas, principal, Date.now(), { ...ctx, tenancyActive });
      const reasons: string[] = [];
      if (!signInAllowed)
        reasons.push(
          "This account is not permitted to sign in by the instance's email policy. Public content may still be available when signed out.",
        );
      if (user?.isBlocked)
        reasons.push(
          "This account is blocked and cannot sign in. Public content may still be available when signed out.",
        );
      if (email && !user)
        reasons.push(
          "This email has not signed in. Pending invitations grant no access until that exact email signs in.",
        );
      if (role === "owner") reasons.push("This person owns the canvas.");
      if (role === "editor")
        reasons.push("This person has effective editor access through the people or teams list.");
      if (direct) reasons.push(`Direct ${direct.role} grant on the people list.`);
      for (const team of matchingTeams) reasons.push(`Access through team ${team.teamName}.`);
      if (pending.length)
        reasons.push(
          `${pending.length} pending invitation(s) are waiting to be accepted at sign-in.`,
        );
      if (canvas.access === "public_link")
        reasons.push(
          ctx.publicEnabled
            ? "Public-link publishing is permitted."
            : role === "editor"
              ? "Editor access applies independently of public-link availability."
              : "Public-link publishing is unavailable for this canvas or owner.",
        );
      if (canvas.access === "whole_org")
        reasons.push(
          tenancyActive
            ? "Whole-org access requires live membership of this canvas's organization."
            : "Whole-org access is available to signed-in members.",
        );
      if (decision.action === "deny") {
        const labels: Record<string, string> = {
          not_found: "The canvas is deleted.",
          archived: "The canvas is archived.",
          disabled: "The canvas has been disabled by an administrator.",
          share_expired: "The sharing window has expired.",
          owner_only: "No currently effective grant admits this person.",
          not_invited: "This person has not been granted access.",
          auth_required: "Sign-in is required.",
        };
        reasons.push(labels[decision.reason] ?? "The current access rules deny access.");
      }
      if (decision.action === "allow" && decision.needsPasswordGate)
        reasons.push(
          "The password must also be entered; this check does not assume a saved password session.",
        );
      if (canvas.currentVersionId === null) reasons.push("There is no published version to view.");
      if (
        role === "none" &&
        !direct &&
        !matchingTeams.length &&
        !pending.length &&
        canvas.access === "private"
      )
        reasons.push("There is no direct or team grant for this restricted canvas.");
      const result =
        !signInAllowed ||
        user?.isBlocked ||
        decision.action === "deny" ||
        canvas.currentVersionId === null
          ? "denied"
          : decision.needsPasswordGate
            ? "password_required"
            : "allowed";
      return {
        email: email ?? null,
        userId: user?.id ?? null,
        subject: user ? "account" : "anonymous",
        managementRole:
          !signInAllowed || user?.isBlocked || canvas.status === "deleted" ? "none" : role,
        result,
        reasons,
        checkedAt: Date.now(),
        staticOnly: decision.action === "allow" && decision.staticOnly,
        pendingInvitations: pending.length,
      };
    },
  };
}
export type AdminInvestigation = ReturnType<typeof adminInvestigation>;
