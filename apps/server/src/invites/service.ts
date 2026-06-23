import type { Config } from "@canvas-drop/shared";
import { isEmailDomainAllowed } from "../auth/identity-mapping.js";
import { canvasUrl } from "../canvas/url.js";
import type { AllowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import type { EmailTemplatesRepository } from "../db/repositories/email-templates.js";
import type { InvitationsRepository } from "../db/repositories/invitations.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { Mailer } from "../email/mailer.js";
import { effectiveTemplate, renderTemplate, type TemplateKey } from "../email/templates.js";
import { HOUR_MS, type RateLimitStore, takeToken } from "../http/rate-limit.js";
import type { Logger } from "../log/logger.js";

/**
 * The invite primitive (plan 003 phase 3 / U5). ONE shared layer every owner-facing invite
 * surface routes through (team add, canvas Specific-people add, individual canvas invite, admin
 * Add-users): rate-limit → resolve → grant-now-or-record-pending → notify.
 *
 * Auth-delegated (KTD3/KTD4): there are no app-owned credentials. An existing user is granted
 * immediately; a brand-new email is recorded as a pending invitation that materializes on the
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
    }
  | { kind: "account" };

/** The verified, server-resolved actor doing the inviting (never client-asserted identity). */
export interface InviteActor {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
}

export type InviteResult =
  | { status: "granted"; userId: string }
  | { status: "already_added"; userId?: string }
  | { status: "pending" }
  | { status: "already_pending" }
  | { status: "blocked"; userId: string }
  | { status: "policy_blocked"; reason: "new_email_not_permitted" }
  | { status: "auth_admission_required" }
  | { status: "rate_limited"; retryAfterSec: number };

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
    }): Promise<unknown>;
    isPrincipalAllowed(
      canvasId: string,
      principal: { userId?: string | null; email?: string | null },
    ): Promise<boolean>;
  };
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
 *  notifies an existing member (only brand-new invitees learn to sign in). */
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
      });
    }
    // account: the person is already a user → they can already sign in; nothing to grant.
  }

  /** Best-effort courtesy/notify email. Master-gated + mailer-gated; never throws (a mail
   *  failure must never block the grant). Takes the already-resolved `settings` so a send
   *  doesn't re-read the settings store. */
  async function notify(
    target: InviteTarget,
    to: string,
    actor: InviteActor,
    settings: EffectiveInviteSettings,
  ): Promise<void> {
    if (!settings.emailEnabled || !deps.mailer.canSend) return;
    try {
      const body = await effectiveTemplate(deps.templates, templateKeyFor(target));
      const link =
        target.kind === "canvas" ? canvasUrl(deps.config, target.canvasSlug) : deps.config.baseUrl;
      const instanceName = await deps.settings.effectiveInstanceName();
      const orgName = target.kind === "account" ? orgNameForEmail(deps.config, to) : undefined;
      const msg = renderTemplate(body, to, {
        inviterName: actor.name,
        instanceName,
        orgName,
        orgContext: orgName ? ` for ${orgName}` : undefined,
        canvasTitle: target.kind === "canvas" ? target.canvasTitle : undefined,
        teamName: target.kind === "team" ? target.teamName : undefined,
        link,
      });
      const res = await deps.mailer.send(msg);
      if (!res.ok) deps.log?.error({ error: res.error }, "invite: courtesy email send failed");
    } catch (err) {
      deps.log?.error({ err }, "invite: courtesy email render/send threw (grant unaffected)");
    }
  }

  return {
    /**
     * Resolve an email to a grant. Existing user → granted now; brand-new email → permit +
     * pending invitation (gated by KTD5) or rejected. Rate-limited per actor; admins bypass the
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
          return { status: "already_added", userId: existing.id };
        }
        await grantNow(target, existing.id);
        if (notifyExisting(target, settings)) await notify(target, email, actor, settings);
        return { status: "granted", userId: existing.id };
      }

      // New email: the KTD5 permit gate.
      const alreadyAuthenticates =
        isEmailDomainAllowed(email, deps.config) || (await deps.allowedEmails.isAllowed(email));

      // In proxy/IAP mode the app cannot create an upstream admission rule. It may record a
      // pending grant only for emails the configured auth path already admits.
      if (deps.config.auth.mode === "proxy" && !alreadyAuthenticates) {
        return { status: "auth_admission_required" };
      }

      const mayPermit = actor.isAdmin || settings.allowMemberNewEmails || alreadyAuthenticates;
      if (!mayPermit) return { status: "policy_blocked", reason: "new_email_not_permitted" };

      if (await alreadyPending(target, email)) return { status: "already_pending" };

      // Pending-cap (un-consumed invitations recorded by this actor). Admins bypass.
      if (!actor.isAdmin) {
        const pending = await deps.invitations.countPendingByActor(actor.id);
        if (pending >= settings.pendingCap) return { status: "rate_limited", retryAfterSec: 3600 };
      }

      // Permit sign-in only when the email can't already authenticate (domain/allowlist).
      if (!alreadyAuthenticates) await deps.allowedEmails.add(email, actor.id);

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
          invitedBy: actor.id,
        });
      }

      if (notifyPending(target, settings)) await notify(target, email, actor, settings);
      return { status: "pending" };
    },
  };
}

export type InviteService = ReturnType<typeof inviteService>;
