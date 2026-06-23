import type { Config } from "@canvas-drop/shared";
import type { Canvas, User } from "@canvas-drop/shared/db";
import type { Logger } from "../log/logger.js";

/**
 * The principal a canvas-facing request acts as (D4 access ladder, U3). Three
 * kinds: an org `member` (the normal gateway path), a retained legacy `guest`
 * session scoped to one canvas, or `anonymous` (a visitor to a public_link canvas).
 * Identity always comes from the server-side resolver,
 * never the client (§12.0 #1). A guest's id is namespaced `guest:<inviteId>` so it
 * never collides with an org user id in KV scoping / audit / presence (KTD2).
 */
export type Principal =
  // `orgIds` = the orgs this member belongs to (plan 002 U3), DERIVED server-side from
  // their verified email domain — never client-asserted. ∅ for a member whose domain
  // matches no org (a "guest-shaped member": signed in, but not in any org). Backs the
  // re-scoped `whole_org` rung in decideCanvasAccess (member of the canvas's home org).
  | { kind: "member"; id: string; isAdmin: boolean; orgIds: Set<string> }
  | { kind: "guest"; id: string; inviteId: string; canvasId: string; email: string }
  | { kind: "anonymous" }
  // The internal screenshot worker rendering one canvas+version for a capture
  // (plan 004 / U3). Set ONLY by the internal capture middleware after verifying a
  // server-minted HMAC token — never by a public-surface resolver, never from a
  // client header. Scoped to one canvas; `decideCanvasAccess` grants it exactly
  // what the owner sees and nothing on any other canvas (§12.0).
  | { kind: "capture"; canvasId: string; versionId: string };

/**
 * Hono context variables available across the app. Populated by the middleware
 * chain: correlation-id/logging (U3), client IP (U11 conninfo), auth gateway (U7),
 * canvas routing/authorization (U15).
 */
export interface AppVariables {
  log: Logger;
  correlationId: string;
  /** The instance's typed config, stashed on the context by an early middleware so
   *  surfaces that render outside a route closure (the branded error pages) can
   *  resolve the dashboard origin + auth mode without a parallel env read (§8.1). */
  config?: Config;
  /** Real TCP socket peer IP (set by the conninfo middleware) — the immediate hop.
   *  Used for the trusted-proxy identity gate (§12.5); NEVER derived from a header. */
  peerIp?: string;
  /** Resolved real end-client IP — equals `peerIp`, except behind a configured
   *  trusted proxy where it is taken from X-Forwarded-For (see http/client-ip.ts).
   *  Used for login rate-limiting and audit logging — never for auth decisions. */
  clientIp?: string;
  /** The authenticated user — guaranteed set by the auth gateway on protected routes. */
  user: User;
  /** The caller's org membership (plan 002 U3), resolved server-side by the gateway
   *  from the user's verified email domain. Carried so `requestPrincipal` can build a
   *  member principal synchronously; ∅ for a member in no org. Never client-asserted. */
  orgIds?: Set<string>;
  /**
   * The canvas-facing principal (U3/U7). Set by the guest/public resolver for a
   * guest or anonymous request; for the normal org path it is derived from `user`.
   * Routes that need the acting principal on the canvas surface read this; org
   * dashboard/management routes keep using `user`.
   */
  principal?: Principal;
  /** Anonymous public-link fallback resolved before auth. Used only when a stale
   *  session/proxy identity cannot authenticate; valid sessions still become members. */
  publicFallbackPrincipal?: Principal;
  /** Static-only access (public_link rung, U3) — set by canvasAccess; the serve
   *  layer serves files but every primitive is refused (R17, enforced in U9/U11). */
  staticOnly?: boolean;
  /** Resolved request role (set by the app's role middleware, U11/U19). */
  role?: "dashboard" | "auth" | "platform-api" | "canvas";
  /** Canvas slug from resolveRequest (canvas + platform-api roles). */
  canvasSlug?: string;
  /** The authorized canvas — set by canvasAccess (U15) on allow. */
  canvas?: Canvas;
  /** Whether the password gate must run before serving — set by canvasAccess (U15). */
  needsPasswordGate?: boolean;
  /** The verified MCP OAuth caller — set by the `/mcp` bearer-auth middleware from a
   *  validated access token. Identity (`userId`) comes only from the server-side token
   *  store, never the client. Tools read this to scope every action to the caller. */
  mcpAuth?: { token: string; clientId: string; userId: string; scopes: string[] };
}

/** The Hono `Env` binding for every route and middleware in the server. */
export interface AppEnv {
  Variables: AppVariables;
}
