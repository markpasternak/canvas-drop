import { type Config, domainOfEmail } from "@canvas-drop/shared";
import type { AccessRole } from "@canvas-drop/shared/db";
import { canvasUrl } from "../canvas/url.js";
import type { AllowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import type { EmailTemplatesRepository } from "../db/repositories/email-templates.js";
import type { InvitationsRepository } from "../db/repositories/invitations.js";
import type { OrgsRepository } from "../db/repositories/orgs.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { Mailer } from "../email/mailer.js";
import { effectiveTemplate, renderTemplate, type TemplateKey } from "../email/templates.js";
import { HOUR_MS, type RateLimitStore, takeToken } from "../http/rate-limit.js";
import type { Logger } from "../log/logger.js";
import { resolveNewEmailAdmission } from "./admission.js";

/**
 * The Add person primitive (plan 003 phase 3 / U5). ONE shared layer every owner-facing
 * person-access surface routes through (team add, canvas Specific people add,
 * individual canvas access, admin sign-in permits): rate-limit → resolve →
 * grant-now-or-record-pending → notify.
 *
 * Auth-delegated (KTD3/KTD4): there are no app-owned credentials. An existing user is granted
 * immediately; a brand-new email is recorded as pending access that materializes on the
 * person's first VERIFIED login (the IdP/proxy is the identity authority — see auth/invitations).
 *
 * KTD5 (the load-bearing gate): a self-serve actor can NOT permit a brand-new external email to
 * sign in. Only an admin, the `allowMemberNewEmails` toggle, or an email that already
 * authenticates (domain-matched or already on the allowlist) opens the new-email permit path.
 */

/** Where the grant lands. `account` is a sign-in permit only (admin Add-users) — no team/canvas. */
export type InviteTarget =
  | { kind: "team"; teamId: string; teamName: string }
  | {
      kind: "canvas";
      canvasId: string;
      canvasSlug: string;
      canvasTitle: string;
      /** `add` = Specific-people add (notifyOnCanvasAdd); `invite` = one-off (notifyOnCanvasInvite). */
      mode: "add" | "invite";
      /** The people-list role to grant (editor-roles plan). Omitted → viewer on a NEW
       *  row and NO change to an existing one; supplied → applied on insert and, for an
       *  existing member, updated in place (KTD3). Editor is refused for a non-org email
       *  (GUEST_VIEWER_ONLY, KD2/KTD2). */
      role?: AccessRole;
    }
  | { kind: "account" };

/** The verified, server-resolved actor doing the inviting (never client-asserted identity). */
export interface InviteActor {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
}

export type InviteEmailDelivery =
  | { status: "sent" }
  | { status: "failed" }
  | { status: "skipped"; reason: "event_disabled" | "email_disabled" | "mailer_disabled" };

type WithInviteEmailDelivery<T> = T & { emailDelivery?: InviteEmailDelivery };

export type InviteResult =
  | WithInviteEmailDelivery<{ status: "granted"; userId: string }>
  | WithInviteEmailDelivery<{ status: "already_added"; userId?: string }>
  /** An existing member's role was changed in place by an add-with-role (KTD3). */
  | WithInviteEmailDelivery<{
      status: "role_changed";
      userId: string;
      role: AccessRole;
      from: AccessRole;
    }>
  /** Editor requested for a guest / non-org email (KD2, KTD2) — nothing was written. */
  | WithInviteEmailDelivery<{ status: "guest_viewer_only" }>
  | WithInviteEmailDelivery<{ status: "pending" }>
  | WithInviteEmailDelivery<{ status: "already_pending" }>
  | WithInviteEmailDelivery<{ status: "blocked"; userId: string }>
  | WithInviteEmailDelivery<{ status: "policy_blocked"; reason: "new_email_not_permitted" }>
  | WithInviteEmailDelivery<{ status: "auth_admission_required" }>
  | WithInviteEmailDelivery<{ status: "rate_limited"; retryAfterSec: number }>;

interface EffectiveInviteSettings {
  emailEnabled: boolean;
  notifyOnAddUser: boolean;
  notifyOnCanvasAdd: boolean;
  notifyOnCanvasInvite: boolean;
  maxPerActorPerHour: number;
  pendingCap: number;
  allowMemberNewEmails: boolean;
}

export interface InviteServiceDeps {
  config: Config;
  users: Pick<UsersRepository, "findByEmail">;
  allowedEmails: Pick<AllowedEmailsRepository, "isAllowed" | "add">;
  invitations: Pick<
    InvitationsRepository,
    "record" | "countPendingByActor" | "hasPendingForTarget"
  >;
  teams: {
    addMember(teamId: string, userId: string): Promise<void>;
    isTeamMember(teamId: string, userId: string): Promise<boolean>;
  };
  canvases: {
    addAllowlistEntry(input: {
      canvasId: string;
      principalKind: "member" | "guest";
      userId?: string | null;
      email?: string | null;
      role?: AccessRole;
    }): Promise<unknown>;
    isPrincipalAllowed(
      canvasId: string,
      principal: { userId?: string | null; email?: string | null },
    ): Promise<boolean>;
    findMemberEntry(canvasId: string, userId: string): Promise<{ role: AccessRole } | null>;
  };
  /** Org store (editor-roles plan, KTD2): an editor grant needs an org-domain email when
   *  tenancy is active. Optional — when absent under active tenancy the check fails closed. */
  orgs?: Pick<OrgsRepository, "findByDomain">;
  settings: {
    effectiveInviteSettings(): Promise<EffectiveInviteSettings>;
    effectiveInstanceName(): Promise<string>;
  };
  /** The email-templates store — the renderer resolves the admin override else the seeded default. */
  templates: Pick<EmailTemplatesRepository, "get">;
  mailer: Mailer;
  rateLimitStore: RateLimitStore;
  log?: Logger;
}

function templateKeyFor(target: InviteTarget): TemplateKey {
  switch (target.kind) {
    case "team":
      return "team_invite";
    case "canvas":
      return target.mode === "add" ? "canvas_invite" : "individual_canvas_invite";
    case "account":
      return "account_invite";
  }
}

/** Whether an EXISTING-user grant emails an FYI (per the event's toggle). A team add never
 *  notifies an existing member (only brand-new people need to learn to sign in). */
function notifyExisting(target: InviteTarget, s: EffectiveInviteSettings): boolean {
  switch (target.kind) {
    case "team":
      return false;
    case "canvas":
      return target.mode === "add" ? s.notifyOnCanvasAdd : s.notifyOnCanvasInvite;
    case "account":
      return s.notifyOnAddUser;
  }
}

/** Whether a NEW-email (pending) courtesy email goes out. The team/canvas courtesy IS the
 *  sign-in invite (master-gated only); Add-users follows its own per-event toggle. */
function notifyPending(target: InviteTarget, s: EffectiveInviteSettings): boolean {
  return target.kind === "account" ? s.notifyOnAddUser : true;
}

/** The configured org name is valid in account copy only when the recipient's verified email
 *  domain would make them an org member. It is never used for external canvas/team grants. */
function orgNameForEmail(config: Config, email: string): string | undefined {
  if (!config.org.name) return undefined;
  const domain = email.split("@").pop()?.toLowerCase();
  return domain && config.org.domains.includes(domain) ? config.org.name : undefined;
}

export function inviteService(deps: InviteServiceDeps) {
  async function alreadyGranted(target: InviteTarget, userId: string): Promise<boolean> {
    if (target.kind === "team") return deps.teams.isTeamMember(target.teamId, userId);
    if (target.kind === "canvas") {
      return deps.canvases.isPrincipalAllowed(target.canvasId, { userId });
    }
    return false;
  }

  async function alreadyPending(target: InviteTarget, email: string): Promise<boolean> {
    if (target.kind === "team") {
      return deps.invitations.hasPendingForTarget("team", target.teamId, email);
    }
    if (target.kind === "canvas") {
      return deps.invitations.hasPendingForTarget("canvas", target.canvasId, email);
    }
    return false;
  }

  /** Apply a grant to an existing user (idempotent at the repo layer). */
  async function grantNow(target: InviteTarget, userId: string): Promise<void> {
    if (target.kind === "team") {
      await deps.teams.addMember(target.teamId, userId);
    } else if (target.kind === "canvas") {
      await deps.canvases.addAllowlistEntry({
        canvasId: target.canvasId,
        principalKind: "member",
        userId,
        role: target.role,
      });
    }
    // account: the person is already a user → they can already sign in; nothing to grant.
  }

  /**
   * KTD2 / KD2: may this email hold the editor role? Under inert tenancy any member
   * qualifies; under active tenancy the email's domain must be one of the org's
   * configured domains (the same derivation the live org-membership resolver uses).
   */
  async function canHoldEditorRole(email: string): Promise<boolean> {
    if (!deps.config.org.name) return true;
    const domain = domainOfEmail(email.trim().toLowerCase());
    if (!domain || !deps.orgs) return false;
    return (await deps.orgs.findByDomain(domain)) !== null;
  }

  /** Best-effort courtesy/notify email. Master-gated + mailer-gated; never throws (a mail
   *  failure must never block the grant). Takes the already-resolved `settings` so a send
   *  doesn't re-read the settings store. */
  async function notify(
    target: InviteTarget,
    to: string,
    actor: InviteActor,
    settings: EffectiveInviteSettings,
  ): Promise<InviteEmailDelivery> {
    if (!settings.emailEnabled) return { status: "skipped", reason: "email_disabled" };
    if (!deps.mailer.canSend) return { status: "skipped", reason: "mailer_disabled" };
    try {
      const body = await effectiveTemplate(deps.templates, templateKeyFor(target));
      const link =
        target.kind === "canvas" ? canvasUrl(deps.config, target.canvasSlug) : deps.config.baseUrl;
      const instanceName = await deps.settings.effectiveInstanceName();
      const orgName = target.kind === "account" ? orgNameForEmail(deps.config, to) : undefined;
      const role = target.kind === "canvas" ? (target.role ?? "viewer") : undefined;
      const msg = renderTemplate(body, to, {
        recipientEmail: to,
        inviterName: actor.name,
        instanceName,
        orgName,
        orgContext: orgName ? ` for ${orgName}` : undefined,
        canvasTitle: target.kind === "canvas" ? target.canvasTitle : undefined,
        teamName: target.kind === "team" ? target.teamName : undefined,
        link,
        role,
        accessLabel: role === "editor" ? "editor" : role === "viewer" ? "view" : undefined,
      });
      const res = await deps.mailer.send(msg);
      if (res.ok) return { status: "sent" };
      deps.log?.error({ error: res.error }, "invite: courtesy email send failed");
    } catch (err) {
      deps.log?.error({ err }, "invite: courtesy email render/send threw (grant unaffected)");
    }
    return { status: "failed" };
  }

  /** Render + send one keyed notice under the master email toggles. Never throws. */
  async function sendKeyed(
    key: TemplateKey,
    rawTo: string,
    vars: Omit<Parameters<typeof renderTemplate>[2], "recipientEmail" | "instanceName">,
  ): Promise<InviteEmailDelivery> {
    const settings = await deps.settings.effectiveInviteSettings();
    if (!settings.emailEnabled) return { status: "skipped", reason: "email_disabled" };
    if (!deps.mailer.canSend) return { status: "skipped", reason: "mailer_disabled" };
    try {
      const body = await effectiveTemplate(deps.templates, key);
      const to = rawTo.trim().toLowerCase();
      const msg = renderTemplate(body, to, {
        ...vars,
        recipientEmail: to,
        instanceName: await deps.settings.effectiveInstanceName(),
      });
      const res = await deps.mailer.send(msg);
      if (res.ok) return { status: "sent" };
      deps.log?.error({ error: res.error, key }, "notice: send failed");
    } catch (err) {
      deps.log?.error({ err, key }, "notice: render/send threw (write unaffected)");
    }
    return { status: "failed" };
  }

  return {
    /**
     * Resolve an email to a grant. Existing user → granted now; brand-new email → permit +
     * pending access (gated by KTD5) or rejected. Rate-limited per actor; admins bypass the
     * caps (the trusted higher ceiling). The email is lowercased/trimmed; idempotent for an
     * already-member (the repo inserts are no-ops on conflict).
     */
    async resolveOrInvite(
      target: InviteTarget,
      rawEmail: string,
      actor: InviteActor,
    ): Promise<InviteResult> {
      const email = rawEmail.trim().toLowerCase();
      const settings = await deps.settings.effectiveInviteSettings();

      // Editor-roles plan (KD2/KTD2): write power never crosses the org boundary. Refused
      // before any token is consumed or anything is written.
      if (
        target.kind === "canvas" &&
        target.role === "editor" &&
        !(await canHoldEditorRole(email))
      ) {
        return { status: "guest_viewer_only" };
      }

      // KTD9 per-actor action rate limit (admins bypass). Consumes a token up front so a flood
      // is refused before any resolve/record/send work.
      if (!actor.isAdmin) {
        const tok = takeToken(
          deps.rateLimitStore,
          `invite:${actor.id}`,
          settings.maxPerActorPerHour,
          HOUR_MS,
        );
        if (!tok.allowed) return { status: "rate_limited", retryAfterSec: tok.retryAfterSec };
      }

      // Existing user → grant immediately + optional FYI. No pending row, so the pending cap
      // does not apply.
      const existing = await deps.users.findByEmail(email);
      if (existing) {
        if (existing.isBlocked) return { status: "blocked", userId: existing.id };
        if (await alreadyGranted(target, existing.id)) {
          // Add-with-role on an EXISTING member updates the role in place (KTD3); a
          // role-less re-add (or the same role) is the idempotent no-op.
          const before =
            target.kind === "canvas"
              ? await deps.canvases.findMemberEntry(target.canvasId, existing.id)
              : null;
          if (target.kind === "canvas" && target.role && before && before.role !== target.role) {
            await grantNow(target, existing.id);
            const emailDelivery =
              target.role === "editor" && notifyExisting(target, settings)
                ? await notify(target, email, actor, settings)
                : ({ status: "skipped", reason: "event_disabled" } as const);
            return {
              status: "role_changed",
              userId: existing.id,
              role: target.role,
              from: before.role,
              emailDelivery,
            };
          }
          return { status: "already_added", userId: existing.id };
        }
        await grantNow(target, existing.id);
        const emailDelivery = notifyExisting(target, settings)
          ? await notify(target, email, actor, settings)
          : target.kind === "team"
            ? undefined
            : ({ status: "skipped", reason: "event_disabled" } as const);
        return emailDelivery
          ? { status: "granted", userId: existing.id, emailDelivery }
          : { status: "granted", userId: existing.id };
      }

      const admission = await resolveNewEmailAdmission({
        config: deps.config,
        email,
        canCreatePermit: actor.isAdmin || settings.allowMemberNewEmails,
        allowedEmails: deps.allowedEmails,
      });
      if (admission.status === "auth_admission_required") {
        return { status: "auth_admission_required" };
      }
      if (admission.status === "policy_blocked") {
        return { status: "policy_blocked", reason: "new_email_not_permitted" };
      }

      if (await alreadyPending(target, email)) return { status: "already_pending" };

      // Pending-cap (un-consumed invitations recorded by this actor). Admins bypass.
      if (!actor.isAdmin) {
        const pending = await deps.invitations.countPendingByActor(actor.id);
        if (pending >= settings.pendingCap) return { status: "rate_limited", retryAfterSec: 3600 };
      }

      // Permit sign-in only when the email can't already authenticate (domain/allowlist).
      if (!admission.alreadyAuthenticates) await deps.allowedEmails.add(email, actor.id);

      // Record the pending grant (team/canvas only — `account` is a permit with no grant row;
      // org membership auto-derives from the domain on first login).
      if (target.kind === "team") {
        await deps.invitations.record({
          email,
          target: { type: "team", id: target.teamId },
          role: "member",
          invitedBy: actor.id,
        });
      } else if (target.kind === "canvas") {
        await deps.invitations.record({
          email,
          target: { type: "canvas", id: target.canvasId },
          // The invited role rides on the pending row and materializes with it (KTD2).
          role: target.role ?? "viewer",
          invitedBy: actor.id,
        });
      }

      const emailDelivery = notifyPending(target, settings)
        ? await notify(target, email, actor, settings)
        : ({ status: "skipped", reason: "event_disabled" } as const);
      return { status: "pending", emailDelivery };
    },

    /** KTD2 / KD2: whether this email may hold the editor role on this instance. */
    canHoldEditorRole,

    /**
     * The canvas courtesy email for a role change made OUTSIDE the add flow (a promotion
     * via set-role, R21) — the same template, toggle, and gating as an add. Never throws.
     */
    async notifyCanvasRole(
      target: Extract<InviteTarget, { kind: "canvas" }>,
      to: string,
      actor: InviteActor,
    ): Promise<InviteEmailDelivery> {
      const settings = await deps.settings.effectiveInviteSettings();
      if (!notifyExisting(target, settings)) return { status: "skipped", reason: "event_disabled" };
      return notify(target, to.trim().toLowerCase(), actor, settings);
    },

    /** The new owner's notice after a transfer / admin reassign (KTD7). Never throws. */
    async notifyOwnershipReceived(input: {
      canvasSlug: string;
      canvasTitle: string;
      to: string;
      actorName: string;
      mode: "transfer" | "reassign";
    }): Promise<InviteEmailDelivery> {
      return sendKeyed("canvas_ownership_received", input.to, {
        inviterName: input.actorName,
        canvasTitle: input.canvasTitle,
        link: canvasUrl(deps.config, input.canvasSlug),
      });
    },

    /** The outgoing owner's notice after an admin reassign (R14). Never throws. */
    async notifyOwnershipReassignedAway(input: {
      canvasSlug: string;
      canvasTitle: string;
      to: string;
      actorName: string;
      newOwnerEmail: string;
      reason: string;
    }): Promise<InviteEmailDelivery> {
      return sendKeyed("canvas_ownership_reassigned", input.to, {
        inviterName: input.actorName,
        canvasTitle: input.canvasTitle,
        personEmail: input.newOwnerEmail,
        reason: input.reason,
        link: canvasUrl(deps.config, input.canvasSlug),
      });
    },

    /**
     * The owner's notice that a NON-owner granted or promoted someone to editor (R21):
     * names the actor, the person, and the canvas; under the same email toggles as the
     * canvas add courtesy. Never throws.
     */
    async notifyOwnerOfEditorGrant(input: {
      canvasSlug: string;
      canvasTitle: string;
      ownerEmail: string;
      personEmail: string;
      actor: InviteActor;
    }): Promise<InviteEmailDelivery> {
      const settings = await deps.settings.effectiveInviteSettings();
      if (!settings.notifyOnCanvasAdd) return { status: "skipped", reason: "event_disabled" };
      if (!settings.emailEnabled) return { status: "skipped", reason: "email_disabled" };
      if (!deps.mailer.canSend) return { status: "skipped", reason: "mailer_disabled" };
      try {
        const body = await effectiveTemplate(deps.templates, "canvas_editor_granted_owner");
        const to = input.ownerEmail.trim().toLowerCase();
        const msg = renderTemplate(body, to, {
          recipientEmail: to,
          inviterName: input.actor.name,
          instanceName: await deps.settings.effectiveInstanceName(),
          canvasTitle: input.canvasTitle,
          personEmail: input.personEmail,
          role: "editor",
          accessLabel: "editor",
          link: canvasUrl(deps.config, input.canvasSlug),
        });
        const res = await deps.mailer.send(msg);
        if (res.ok) return { status: "sent" };
        deps.log?.error({ error: res.error }, "invite: owner editor notice send failed");
      } catch (err) {
        deps.log?.error(
          { err },
          "invite: owner editor notice render/send threw (grant unaffected)",
        );
      }
      return { status: "failed" };
    },
  };
}

export type InviteService = ReturnType<typeof inviteService>;
