import type { Canvas, User } from "@canvas-drop/shared/db";
import type { Logger } from "../log/logger.js";

/**
 * The principal a canvas-facing request acts as (D4 access ladder, U3). Three
 * kinds: an org `member` (the normal gateway path), an invited `guest` (a
 * magic-link session scoped to one canvas — U6/U7), or `anonymous` (a visitor to
 * a public_link canvas — U7). Identity always comes from the server-side resolver,
 * never the client (§12.0 #1). A guest's id is namespaced `guest:<inviteId>` so it
 * never collides with an org user id in KV scoping / audit / presence (KTD2).
 */
export type Principal =
  | { kind: "member"; id: string; isAdmin: boolean }
  | { kind: "guest"; id: string; inviteId: string; canvasId: string; email: string }
  | { kind: "anonymous" };

/**
 * Hono context variables available across the app. Populated by the middleware
 * chain: correlation-id/logging (U3), client IP (U11 conninfo), auth gateway (U7),
 * canvas routing/authorization (U15).
 */
export interface AppVariables {
  log: Logger;
  correlationId: string;
  /** Real TCP socket peer IP (set by the conninfo middleware) — the immediate hop.
   *  Used for the trusted-proxy identity gate (§12.5); NEVER derived from a header. */
  peerIp?: string;
  /** Resolved real end-client IP — equals `peerIp`, except behind a configured
   *  trusted proxy where it is taken from X-Forwarded-For (see http/client-ip.ts).
   *  Used for login rate-limiting and audit logging — never for auth decisions. */
  clientIp?: string;
  /** The authenticated user — guaranteed set by the auth gateway on protected routes. */
  user: User;
  /**
   * The canvas-facing principal (U3/U7). Set by the guest/public resolver for a
   * guest or anonymous request; for the normal org path it is derived from `user`.
   * Routes that need the acting principal on the canvas surface read this; org
   * dashboard/management routes keep using `user`.
   */
  principal?: Principal;
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
