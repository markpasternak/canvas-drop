import { createHash } from "node:crypto";
import type { AuditLog } from "../audit/audit-log.js";
import type { OrgMembershipResolver } from "../auth/org-membership.js";
import type { OwnershipService } from "../canvas/ownership.js";
import type { AllowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { InvitationsRepository } from "../db/repositories/invitations.js";
import type { OffboardingRepository } from "../db/repositories/offboarding.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { Logger } from "../log/logger.js";
import type { RealtimeHub } from "../realtime/hub.js";

export interface OffboardingDeps {
  orgMembership?: OrgMembershipResolver;
  repository: OffboardingRepository;
  users: UsersRepository;
  canvases: CanvasesRepository;
  teams: TeamsRepository;
  invitations: InvitationsRepository;
  allowedEmails: AllowedEmailsRepository;
  ownership: OwnershipService;
  revokeSessions: (userId: string) => Promise<void>;
  revokeMcpTokens: (userId: string) => Promise<void>;
  audit: AuditLog;
  log: Logger;
  hub?: RealtimeHub;
}
export type OffboardingOutcome = {
  kind: string;
  id: string;
  label: string;
  status: "done" | "failed" | "unresolved";
  message: string;
};
export class OffboardingError extends Error {
  constructor(
    public code: "SELF" | "CHANGED" | "CONFIRMATION_REQUIRED" | "ACCOUNT_REFUSED",
    message: string,
  ) {
    super(message);
  }
}

export function offboardingService(deps: OffboardingDeps) {
  async function preview(email: string, actorId: string, toUserId?: string) {
    const user = await deps.users.findByEmail(email);
    const orgIds = user && deps.orgMembership ? await deps.orgMembership(user) : new Set<string>();
    const organizations = await deps.repository.organizationNames([...orgIds]);
    const [inventory, memberships, pending, recipient] = await Promise.all([
      deps.repository.inventory(email, user?.id),
      user ? deps.teams.listForUser(user.id) : Promise.resolve([]),
      deps.invitations.listForEmail(email),
      toUserId ? deps.users.findById(toUserId) : Promise.resolve(null),
    ]);
    const owned = [];
    for (const row of inventory.owned) {
      const canvas = await deps.canvases.findById(row.id);
      const eligibility =
        toUserId && canvas ? await deps.ownership.previewReassign(canvas, actorId, toUserId) : null;
      owned.push({
        ...row,
        transferEligible: eligibility?.ok === true,
        transferExplanation:
          eligibility && !eligibility.ok
            ? eligibility.message
            : !toUserId
              ? "Choose a successor or leave this ownership unresolved"
              : null,
        publicLinkReverted: eligibility?.ok
          ? eligibility.publicLinkReverted
          : row.access === "public_link",
      });
    }
    const data = {
      email,
      organizations,
      user: user
        ? {
            id: user.id,
            name: user.name,
            isAdmin: user.isAdmin,
            isBlocked: user.isBlocked,
            canPublishPublic: user.canPublishPublic,
          }
        : null,
      recipient: recipient
        ? {
            id: recipient.id,
            email: recipient.email,
            blocked: recipient.isBlocked,
            canPublishPublic: recipient.canPublishPublic,
          }
        : null,
      owned,
      direct: inventory.direct,
      permits: inventory.permits,
      createdTeams: inventory.createdTeams,
      memberships: memberships
        .map((team) => ({ id: team.id, name: team.name }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      pending: pending
        .map((invite) => ({
          id: invite.id,
          targetId: invite.targetId,
          targetType: invite.targetType,
          role: invite.role,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      self: user?.id === actorId,
    };
    return {
      ...data,
      fingerprint: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
    };
  }

  return {
    preview,
    async execute(
      input: {
        email: string;
        toUserId?: string;
        fingerprint: string;
        reason: string;
        confirmation: string;
      },
      actor: { id: string; name: string },
    ) {
      if (input.confirmation !== `OFFBOARD ${input.email}`)
        throw new OffboardingError(
          "CONFIRMATION_REQUIRED",
          "Type the exact confirmation shown in the preview.",
        );
      const before = await preview(input.email, actor.id, input.toUserId);
      if (before.self) throw new OffboardingError("SELF", "You cannot offboard yourself.");
      if (before.fingerprint !== input.fingerprint)
        throw new OffboardingError(
          "CHANGED",
          "Access or ownership changed. Review a fresh preview.",
        );
      const outcomes: OffboardingOutcome[] = [];
      const userId = before.user?.id;
      const toUserId = input.toUserId;
      const record = async (
        kind: string,
        id: string,
        label: string,
        work: () => Promise<unknown>,
      ) => {
        try {
          await work();
          deps.audit.recordAudit({
            action: "user_offboard_step",
            actorId: actor.id,
            targetType: "user",
            targetId: userId ?? input.email,
            meta: { step: kind, resourceId: id, reason: input.reason },
          });
          outcomes.push({ kind, id, label, status: "done", message: "Completed" });
        } catch (err) {
          deps.log.error({ err, kind, id }, "offboarding step failed");
          outcomes.push({ kind, id, label, status: "failed", message: "Failed; review and retry" });
        }
      };
      if (userId) {
        const result = await deps.repository.blockAccount(userId, actor.id);
        if (result !== "blocked")
          throw new OffboardingError(
            "ACCOUNT_REFUSED",
            "The account cannot be blocked. Check the acting administrator and last-admin protection.",
          );
        deps.audit.recordAudit({
          action: "user_block",
          targetType: "user",
          targetId: userId,
          actorId: actor.id,
          meta: { reason: input.reason },
        });
        if (before.user?.isAdmin)
          deps.audit.recordAudit({
            action: "user_demote",
            actorId: actor.id,
            targetType: "user",
            targetId: userId,
            meta: { reason: input.reason },
          });
        outcomes.push({
          kind: "account",
          id: userId,
          label: input.email,
          status: "done",
          message: "Account blocked",
        });
        await record("sessions", userId, "Sign-in sessions", () => deps.revokeSessions(userId));
        await record("tokens", userId, "Agent access tokens", () => deps.revokeMcpTokens(userId));
      }
      await record("legacy_sessions", input.email, "Legacy guest sessions", () =>
        deps.repository.revokeLegacyGuestSessions(input.email),
      );
      for (const row of before.owned) {
        if (!row.transferEligible || !toUserId) {
          outcomes.push({
            kind: "canvas",
            id: row.id,
            label: row.title || row.slug,
            status: "unresolved",
            message: row.transferExplanation ?? "Choose another successor",
          });
          continue;
        }
        await record("canvas", row.id, row.title || row.slug, async () => {
          const live = await deps.canvases.findById(row.id);
          if (
            !live ||
            live.ownerId !== before.user?.id ||
            live.updatedAt !== row.updatedAt ||
            live.purgeStartedAt !== null
          )
            throw new Error("Canvas changed since preview");
          const moved = await deps.ownership.reassign(live, actor, toUserId, input.reason);
          if (!moved.ok) throw new Error(moved.message);
        });
      }
      if (userId) {
        await record(
          "public_publishing",
          userId,
          "Public publishing and remaining deploy keys",
          async () => {
            await deps.users.setPublishPublic(userId, false);
            await deps.canvases.revertPublicForOwner(userId);
            await deps.repository.revokeRemainingOwnerKeys(userId);
          },
        );
      }
      for (const grant of before.direct)
        await record("direct_grant", grant.id, grant.title || grant.canvasId, () =>
          deps.repository.removeDirect(grant.id, input.email, before.user?.id),
        );
      if (userId)
        for (const membership of before.memberships)
          await record("membership", membership.id, membership.name, () =>
            deps.teams.removeMember(membership.id, userId),
          );
      for (const invite of before.pending)
        await record("invitation", invite.id, `${invite.targetType} invitation`, () =>
          deps.invitations.cancelPending(invite.id),
        );
      for (const permit of before.permits)
        await record("sign_in_permit", permit.id, "Individual sign-in permission", () =>
          deps.allowedEmails.remove(permit.id),
        );
      if (deps.hub)
        for (const id of deps.hub.activeCanvasIds())
          await deps.hub
            .revalidateCanvas(id)
            .catch((err) =>
              deps.log.warn({ err, canvasId: id }, "offboarding: socket revalidation failed"),
            );
      const after = await preview(input.email, actor.id, input.toUserId);
      const unresolved = [
        ...after.owned.map((item) => `Ownership: ${item.title || item.slug}`),
        ...after.direct.map((item) => `Direct access: ${item.title || item.canvasId}`),
        ...after.memberships.map((item) => `Team membership: ${item.name}`),
        ...after.pending.map((item) => `Pending invitation: ${item.targetType} ${item.targetId}`),
        ...after.permits.map(() => "Individual sign-in permission remains"),
        ...after.createdTeams.map(
          (item) =>
            `Team still attributed to this creator: ${item.name}. Review its ongoing administration.`,
        ),
        ...(after.user && !after.user.isBlocked ? ["Account is still active"] : []),
      ];
      const failed = outcomes.filter((item) => item.status === "failed").length;
      deps.audit.recordAudit({
        action: "user_offboard",
        targetType: "user",
        targetId: before.user?.id ?? input.email,
        actorId: actor.id,
        meta: {
          reason: input.reason,
          reassigned: outcomes.filter((item) => item.kind === "canvas" && item.status === "done")
            .length,
          failed,
          unresolved: unresolved.length,
        },
      });
      return {
        outcomes,
        unresolved,
        complete: failed === 0 && unresolved.length === 0,
        accountBlocked: after.user?.isBlocked ?? null,
      };
    },
  };
}
export type OffboardingService = ReturnType<typeof offboardingService>;
