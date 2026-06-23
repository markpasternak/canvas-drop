import type { Config } from "@canvas-drop/shared";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AllowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { AppEnv } from "../http/types.js";
import { isEmailAllowed, mapIdentityToUser } from "./identity-mapping.js";
import { type InvitationApplyDeps, materializePendingInvitations } from "./invitations.js";
import type { OrgMembershipResolver } from "./org-membership.js";
import { loginUrl, requestReturnTo } from "./return-to.js";
import type { AuthStrategy } from "./strategy.js";

/** An auth-lifecycle event for the audit log. Implemented by U10's audit sink. */
export interface AuthEvent {
  action: "auth_ok" | "auth_denied";
  actorId?: string;
  email?: string;
  ip?: string;
  reason?: string;
}

/** Best-effort, non-blocking sink for auth events (U10). */
export interface AuthEventSink {
  record(event: AuthEvent): void;
}

export interface AuthGatewayDeps {
  strategy: AuthStrategy;
  config: Config;
  users: UsersRepository;
  /** Admin-managed individual email allowlist (D14 supplement to the env domains). */
  allowedEmails: Pick<AllowedEmailsRepository, "isAllowed">;
  /** Resolves the caller's org membership from their verified identity (plan 002 U3).
   *  Server-derived (email domain → org), never client-asserted. */
  orgMembership: OrgMembershipResolver;
  /** Materialize-on-verified-login (plan 003 U4): apply pending access for the verified
   *  email. Best-effort — failures never block login. Omit to disable (e.g. legacy tests). */
  invitations?: InvitationApplyDeps;
  audit?: AuthEventSink;
}

/**
 * The auth gateway (BUILD_BRIEF.md §12.0/§12.1.1 — "login on every request").
 * Mode-agnostic: it resolves identity via the configured strategy, enforces the
 * email-domain allowlist, maps identity → user (admin bootstrap), rejects blocked
 * users, and sets the authenticated user on the context. Identity always comes
 * from the server-side strategy — never from anything the client sends.
 */
export function authGateway(deps: AuthGatewayDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const ip = c.get("clientIp");
    const identity = await deps.strategy.resolveIdentity(c);

    if (!identity) {
      const fallback = c.get("publicFallbackPrincipal");
      if (fallback?.kind === "anonymous") {
        c.set("principal", fallback);
        await next();
        return;
      }
      deps.audit?.record({ action: "auth_denied", reason: "no_identity", ip });
      return unauthorized(c, deps.config);
    }

    if (!(await isEmailAllowed(identity.email, deps.config, deps.allowedEmails, c.get("log")))) {
      deps.audit?.record({
        action: "auth_denied",
        reason: "domain_not_allowed",
        email: identity.email,
        ip,
      });
      return unauthorized(c, deps.config);
    }

    const user = await mapIdentityToUser(deps.users, identity, deps.config);
    if (user.isBlocked) {
      deps.audit?.record({ action: "auth_denied", reason: "blocked", actorId: user.id, ip });
      return c.json({ error: "forbidden" }, 403);
    }

    // Materialize-on-verified-login (plan 003 U4): apply any pending access for this
    // verified email. The email is the server-resolved identity, never client input; the apply
    // is idempotent and best-effort, so it never blocks the request. This is the only login
    // path proxy mode has, so the hook lives here rather than in the oidc callback alone.
    if (deps.invitations) {
      await materializePendingInvitations(
        deps.invitations,
        { id: user.id, email: user.email },
        c.get("log"),
      );
    }

    // Resolve org membership server-side (plan 002 U3) and carry it on the context so
    // `requestPrincipal` can build the member principal synchronously. Derived from the
    // verified user, never from anything the client sent.
    const orgIds = await deps.orgMembership(user);

    deps.audit?.record({ action: "auth_ok", actorId: user.id, ip });
    c.set("user", user);
    c.set("orgIds", orgIds);
    await next();
  });
}

function unauthorized(c: Context<AppEnv>, config: Config) {
  // In oidc mode the app owns login; elsewhere a missing identity is a hard 401
  // (proxy mode should never reach the app unauthenticated — the IAP bounces it).
  if (config.auth.mode === "oidc") {
    // Carry where the visitor was headed so login returns them there (a shared
    // canvas on a subdomain, not the apex welcome page). Rebuild from the forwarded
    // Host — c.req.url is the proxy's internal http origin behind Caddy.
    const returnTo = requestReturnTo(config, c.req.header("host"), c.req.url);
    return c.redirect(loginUrl(config, returnTo));
  }
  return c.json({ error: "unauthorized" }, 401);
}
