import type { Config } from "@canvas-drop/shared";
import { mcpAuthRouter, StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuditLog } from "../audit/audit-log.js";
import type { GuestService } from "../auth/guest.js";
import type { AuthStrategy } from "../auth/strategy.js";
import { bearerToken } from "../canvas/api-key.js";
import type { AllowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { OauthRepository } from "../db/repositories/oauth.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { DeployEngine } from "../deploy/engine.js";
import { type RateLimitStore, takeToken } from "../http/rate-limit.js";
import type { AppEnv } from "../http/types.js";
import type { RealtimeHub } from "../realtime/hub.js";
import type { StorageDriver } from "../storage/driver.js";
import type { UploadService } from "../upload/service.js";
import { type McpAuditSink, McpOAuthProvider } from "./provider.js";
import { buildMcpServer } from "./server.js";

export interface McpRoutesDeps {
  config: Config;
  strategy: AuthStrategy;
  users: UsersRepository;
  allowedEmails: Pick<AllowedEmailsRepository, "isAllowed">;
  oauth: OauthRepository;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  engine: DeployEngine;
  /** Two-channel staging upload service (plan 003) — backs the MCP upload tools. */
  upload: UploadService;
  /** Blob store — read-only here, backs the `get_canvas_file` verification tool. */
  storage: StorageDriver;
  /** Guest magic-link service (oidc/dev only) — backs the guest-access MCP tools. */
  guests?: GuestService;
  audit: AuditLog;
  /** Optional OAuth-lifecycle audit sink (U6); the tool layer uses `audit` directly. */
  oauthAudit?: McpAuditSink;
  /** Shared rate-limit store (U6) — throttles tool calls per authenticated caller. */
  rateLimitStore?: RateLimitStore;
  hub?: RealtimeHub;
}

/**
 * The remote MCP surface (U4 + U5), mounted as a native Hono sub-app BEFORE the
 * session gateway with its own auth. `@hono/mcp` supplies the OAuth authorization
 * server (authorize / token / register / revoke + RFC 8414 / 9728 metadata) and the
 * Streamable-HTTP transport; we supply the provider (U3) and the tool server (U5).
 *
 * The whole module is mounted only when `config.mcp.enabled` — when disabled the
 * routes are not present at all (not 403'd), mirroring how proxy mode declines to
 * mount the guest resolver.
 */
export function mcpRoutes(deps: McpRoutesDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const provider = new McpOAuthProvider({
    config: deps.config,
    strategy: deps.strategy,
    users: deps.users,
    allowedEmails: deps.allowedEmails,
    oauth: deps.oauth,
    audit: deps.oauthAudit,
  });

  // OAuth AS endpoints + authorization-server / protected-resource metadata. Must
  // mount at root so the `.well-known/*` discovery documents resolve (RFC 8414/9728).
  app.route(
    "/",
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(deps.config.baseUrl),
      scopesSupported: ["canvas-drop"],
      resourceName: "canvas-drop",
    }),
  );

  // Built from the configured base URL (not the request origin) so the scheme is
  // correct behind a TLS-terminating proxy — the internal hop is plain http, which
  // would otherwise advertise an http:// metadata URL on an https instance.
  const resourceMetadataUrl = `${new URL(deps.config.baseUrl).origin}/.well-known/oauth-protected-resource`;

  // The MCP endpoint, guarded by a verified access token. The bearer check resolves
  // the caller's identity from the token store (never the request) and stashes it for
  // the tool layer. A failure returns 401 directly (not a thrown HTTPException, which
  // the app's onError would turn into a 500), carrying the RFC 9728 resource_metadata
  // hint so clients can discover the authorization server.
  app.all(
    "/mcp",
    async (c, next) => {
      const challenge = `Bearer error="Unauthorized", resource_metadata="${resourceMetadataUrl}"`;
      const deny = () => {
        c.header("WWW-Authenticate", challenge);
        return c.json({ error: "unauthorized" }, 401);
      };
      const token = bearerToken(c.req.header("authorization"));
      if (!token) return deny();
      let userId: string | undefined;
      try {
        const info = await provider.verifyAccessToken(token);
        userId = (info.extra as { userId?: string } | undefined)?.userId;
        if (!userId) return deny();
        c.set("mcpAuth", { token, clientId: info.clientId, userId, scopes: info.scopes });
      } catch {
        return deny();
      }
      // Per-caller throttle (proportionate to the trusted-org model) — reuses the
      // canvas-API class limit, keyed by the verified user, not the request.
      if (deps.rateLimitStore && deps.config.rateLimit.enabled) {
        const r = takeToken(
          deps.rateLimitStore,
          `mcp:${userId}`,
          deps.config.rateLimit.canvasApiPerMin,
        );
        if (!r.allowed) {
          c.header("Retry-After", String(r.retryAfterSec));
          return c.json({ error: "rate_limited" }, 429);
        }
      }
      await next();
    },
    async (c) => {
      const auth = c.get("mcpAuth");
      if (!auth) return c.json({ error: "unauthorized" }, 401);
      // Fresh transport + server per request (stateless), bound to the verified caller.
      const transport = new StreamableHTTPTransport();
      const server = buildMcpServer(
        {
          config: deps.config,
          users: deps.users,
          canvases: deps.canvases,
          versions: deps.versions,
          engine: deps.engine,
          upload: deps.upload,
          storage: deps.storage,
          guests: deps.guests,
          audit: deps.audit,
          hub: deps.hub,
        },
        { userId: auth.userId },
      );
      await server.connect(transport);
      try {
        return await transport.handleRequest(c);
      } catch (e) {
        // The transport throws an HTTPException carrying a spec-compliant JSON-RPC
        // error for protocol faults (wrong Accept/Content-Type, unparseable body).
        // Return that response directly — the app's onError would otherwise flatten
        // it into an opaque 500.
        if (e instanceof HTTPException) return e.getResponse();
        throw e;
      }
    },
  );

  return app;
}
