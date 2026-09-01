import { mcpAuthRouter, StreamableHTTPTransport } from "@hono/mcp";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { makeOrgMembershipResolver } from "../auth/org-membership.js";
import type { AuthStrategy } from "../auth/strategy.js";
import { bearerToken } from "../canvas/api-key.js";
import { memberPrincipal } from "../canvas/authorization.js";
import { loadManagementGrant } from "../canvas/role.js";
import { VersionHistoryError } from "../canvas/version-history.js";
import type { AllowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import type { OauthRepository } from "../db/repositories/oauth.js";
import { LIMITS } from "../deploy/errors.js";
import { type RateLimitStore, takeToken } from "../http/rate-limit.js";
import type { AppEnv } from "../http/types.js";
import { type McpAuditSink, McpOAuthProvider } from "./provider.js";
import { buildMcpServer, type McpToolDeps } from "./server.js";

/**
 * The OAuth-layer deps for the remote MCP routes. Everything the tool server needs
 * comes from {@link McpToolDeps} (extended below) so the two interfaces can't drift —
 * a new tool dependency is added in one place and flows straight through to
 * `buildMcpServer`. This interface adds only the OAuth / transport-layer extras.
 */
export interface McpRoutesDeps extends McpToolDeps {
  strategy: AuthStrategy;
  allowedEmails: Pick<AllowedEmailsRepository, "isAllowed">;
  oauth: OauthRepository;
  /** Optional OAuth-lifecycle audit sink (U6); the tool layer uses `audit` directly. */
  oauthAudit?: McpAuditSink;
  /** Shared rate-limit store (U6) — throttles tool calls per authenticated caller. */
  rateLimitStore?: RateLimitStore;
}

/** Headroom above the 100 MB canvas cap for the JSON-RPC + base64 framing overhead of
 *  the largest in-band MCP payload (a single-call deploy or a custom-preview image). */
const MCP_BODY_LIMIT = LIMITS.maxCanvasBytes + 10 * 1024 * 1024;

/**
 * The remote MCP surface (U4 + U5), mounted as a native Hono sub-app BEFORE the
 * session gateway with its own auth. `@hono/mcp` supplies the OAuth authorization
 * server (authorize / token / register / revoke + RFC 8414 / 9728 metadata) and the
 * Streamable-HTTP transport; we supply the provider (U3) and the tool server (U5).
 *
 * The whole module is mounted only when `config.mcp.enabled` — when disabled the
 * routes are not present at all (not 403'd), matching the app's "absent when disabled"
 * posture for optional pre-gateway surfaces.
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

  /** Shared live-token + per-caller throttle for JSON-RPC and binary exports. */
  const bearerGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
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
  };

  // Binary handoff for complete version exports. MCP returns this URL rather
  // than the archive bytes; the client streams it with the same OAuth bearer so
  // large canvases never enter model context.
  app.get("/mcp/canvases/:id/versions/:number/download", bearerGuard, async (c) => {
    const auth = c.get("mcpAuth");
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    // Owner OR editor (editor-roles plan, KTD1): the same role gate as the tools, with
    // the caller's org membership resolved server-side exactly as the /mcp handler does.
    const user = await deps.users.findById(auth.userId);
    const orgIds = user
      ? await makeOrgMembershipResolver(deps.orgs, deps.orgMembers)(user)
      : new Set<string>();
    const grant = await loadManagementGrant(
      c.req.param("id"),
      memberPrincipal({ id: auth.userId, isAdmin: user?.isAdmin ?? false }, orgIds),
      { canvases: deps.canvases, tenancyActive: !!deps.config.org.name },
    );
    if (!grant) return c.json({ error: "not_found" }, 404);
    const canvas = grant.canvas;
    const number = Number(c.req.param("number"));
    if (!Number.isInteger(number) || number < 1) {
      return c.json({ error: "invalid_version" }, 400);
    }
    try {
      const archive = await deps.versionHistory.archive(canvas, number);
      return new Response(archive.bytes, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${archive.filename}"`,
          "Content-Length": String(archive.bytes.byteLength),
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    } catch (err) {
      if (err instanceof VersionHistoryError) {
        if (err.code === "VERSION_NOT_FOUND") {
          return c.json({ code: "NOT_FOUND", message: err.message }, 404);
        }
        deps.log.error(
          { err, canvasId: canvas.id, version: number },
          "MCP version archive incomplete",
        );
        return c.json({ code: "VERSION_INCOMPLETE", message: err.message }, 503);
      }
      throw err;
    }
  });

  // The MCP endpoint, guarded by a verified access token. The bearer check resolves
  // the caller's identity from the token store (never the request) and stashes it for
  // the tool layer. A failure returns 401 directly (not a thrown HTTPException, which
  // the app's onError would turn into a 500), carrying the RFC 9728 resource_metadata
  // hint so clients can discover the authorization server.
  app.all(
    "/mcp",
    // Reject an oversized JSON-RPC body BEFORE it is buffered — the per-tool service
    // checks only fire after the whole body is in memory. Mirrors the HTTP deploy
    // routes' deployBodyLimit. Mounted ahead of the bearer check so a giant body is
    // dropped even from an unauthenticated caller.
    bodyLimit({
      maxSize: MCP_BODY_LIMIT,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
    bearerGuard,
    async (c) => {
      const auth = c.get("mcpAuth");
      if (!auth) return c.json({ error: "unauthorized" }, 401);
      // Resolve the caller's org membership server-side (plan 002 U7) from the verified
      // user — same DI resolver the gateway uses; never anything the client asserted.
      const user = await deps.users.findById(auth.userId);
      const orgIds = user
        ? await makeOrgMembershipResolver(deps.orgs, deps.orgMembers)(user)
        : new Set<string>();
      // Fresh transport + server per request (stateless), bound to the verified caller.
      // `McpRoutesDeps extends McpToolDeps`, so structural subtyping lets us pass the
      // deps straight through — no field-by-field reconstruction to drift out of sync.
      const transport = new StreamableHTTPTransport();
      const server = buildMcpServer(deps, {
        userId: auth.userId,
        isAdmin: user?.isAdmin ?? false,
        orgIds,
        tenancyActive: !!deps.config.org.name,
      });
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
