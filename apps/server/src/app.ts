import type { Config } from "@canvas-drop/shared";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { UpgradeWebSocket } from "hono/ws";
import { adminSettingsService } from "./admin/settings-service.js";
import { anthropicProvider, type ModelProvider } from "./ai/provider.js";
import type { AuditLog } from "./audit/audit-log.js";
import { authGateway } from "./auth/gateway.js";
import { authRoutes } from "./auth/routes.js";
import type { SessionService } from "./auth/session.js";
import type { AuthStrategy } from "./auth/strategy.js";
import { canvasAccess } from "./canvas/authorization.js";
import { filesService } from "./canvas/files-service.js";
import { passwordGate } from "./canvas/password-gate.js";
import { serveCanvas } from "./canvas/serve.js";
import { serveSpa } from "./dashboard/serve-spa.js";
import type { DbClient } from "./db/factory.js";
import { adminRepository } from "./db/repositories/admin.js";
import { aiUsageRepository } from "./db/repositories/ai-usage.js";
import type { CanvasesRepository } from "./db/repositories/canvases.js";
import type { DraftsRepository } from "./db/repositories/drafts.js";
import { filesRepository } from "./db/repositories/files.js";
import { kvRepository } from "./db/repositories/kv.js";
import { settingsRepository } from "./db/repositories/settings.js";
import { usageEventsRepository } from "./db/repositories/usage-events.js";
import type { UsersRepository } from "./db/repositories/users.js";
import type { VersionsRepository } from "./db/repositories/versions.js";
import type { DeployEngine } from "./deploy/engine.js";
import { docsRoutes } from "./docs/routes.js";
import { draftService } from "./draft/service.js";
import { checkHealth } from "./health.js";
import { canvasApiPreflight } from "./http/canvas-api-isolation.js";
import { resolveClientIp } from "./http/client-ip.js";
import { errorPageMiddleware, errorResponse } from "./http/error-pages.js";
import { legalRoutes } from "./http/legal-pages.js";
import {
  inProcessRateLimitStore,
  type RateLimitStore,
  rateLimit,
  takeToken,
} from "./http/rate-limit.js";
import { securityHeadersMiddleware } from "./http/security-headers.js";
import type { AppEnv } from "./http/types.js";
import type { Logger } from "./log/logger.js";
import { requestLogger } from "./log/middleware.js";
import type { RealtimeHub } from "./realtime/hub.js";
import { adminRoutes } from "./routes/admin.js";
import { canvasApiRoutes } from "./routes/canvas-api.js";
import { deployApiRoutes } from "./routes/deploy-api.js";
import { draftApiRoutes } from "./routes/draft-api.js";
import { galleryRoutes } from "./routes/gallery.js";
import { managementRoutes } from "./routes/management.js";
import { meRoutes } from "./routes/me.js";
import { serveSdkRoutes } from "./routes/serve-sdk.js";
import { resolveRequest } from "./routing/resolve-request.js";
import type { StorageDriver } from "./storage/driver.js";

export interface BuildAppDeps {
  config: Config;
  db: DbClient;
  rootLogger: Logger;
  strategy: AuthStrategy;
  users: UsersRepository;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  drafts: DraftsRepository;
  storage: StorageDriver;
  engine: DeployEngine;
  audit: AuditLog;
  sessionSvc?: SessionService;
  oidc?: Parameters<typeof authRoutes>[0]["oidc"];
  /** Override the socket-peer-IP extractor (tests inject a fixed peer). */
  peerIp?: (c: import("hono").Context<AppEnv>) => string | undefined;
  /** Inject a rate-limit store (tests use a fake clock); defaults to in-process. */
  rateLimitStore?: RateLimitStore;
  /** AI model provider (default Anthropic from config; tests inject a fake). */
  aiProvider?: ModelProvider;
  /** Shared realtime hub (constructed in index.ts; used by the WS route + revoke hooks). */
  hub?: RealtimeHub;
  /**
   * Called once with the composed app to obtain the WebSocket upgrade helper
   * (`@hono/node-ws`). Returns `upgradeWebSocket`; the caller (index.ts) captures
   * `injectWebSocket` via closure to attach after `serve()`. Omitted → no realtime.
   */
  registerWebSocket?: (app: Hono<AppEnv>) => UpgradeWebSocket;
}

/**
 * Compose the single role-routed Hono app (BUILD_BRIEF.md §9.1).
 *
 * Auth has two parallel paths:
 *  - the Bearer-key **deploy API** (`/v1/canvases/*`) authenticates by the canvas
 *    secret key and mounts BEFORE the session gateway — agents/CI have no org
 *    session (§4.5, §11.4);
 *  - everything else (management API, canvas content) sits behind the session
 *    gateway (login on every request, §12.1.1).
 *
 * Canvas content runs the authorization → password-gate → serve chain (U15–U17),
 * gated to the `canvas` role. The dashboard SPA (area E) is served for the
 * `dashboard` role behind the gateway; platform-api (areas F–R) still answers
 * "not built yet".
 */
export function buildApp(deps: BuildAppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Admin-tunable global quota defaults (M7, §6.10.4) over the settings store.
  // `effectiveQuota` is the resolver the KV/files primitives read (settings
  // override ?? their hard constant); admin reads/writes go through the same svc.
  const settingsSvc = adminSettingsService({
    settings: settingsRepository(deps.db),
    config: deps.config,
  });

  // One shared in-process rate-limit store (§9.7, M7) — used by the broad
  // post-gateway middleware AND the out-of-band mount points (Bearer deploy,
  // login, password-gate) so MAX_KEYS bounds everything. Per-buildApp = per-test
  // isolation.
  const rlStore = deps.rateLimitStore ?? inProcessRateLimitStore();
  // Obtain the WebSocket upgrade helper for THIS app instance (chicken-and-egg:
  // @hono/node-ws needs the app; the route needs the helper). Realtime is wired
  // only when both the helper and the hub are present.
  const upgradeWebSocket = deps.registerWebSocket?.(app);
  const realtime = upgradeWebSocket && deps.hub ? { hub: deps.hub, upgradeWebSocket } : undefined;

  app.use("*", requestLogger(deps.rootLogger));

  // §12.4 baseline security headers for JSON/text API responses (M7). Set before
  // the handlers so `c.json` inherits them; self-Response surfaces (canvas serve,
  // SPA, file serving, disabled page) call `baseSecurityHeaders` directly.
  app.use("*", securityHeadersMiddleware());
  app.use("*", errorPageMiddleware());

  app.onError((err, c) => {
    deps.rootLogger.error({ err }, "request failed");
    return errorResponse(
      c,
      {
        status: 500,
        code: "internal_server_error",
        title: "Internal server error",
        message: "The server hit an unexpected problem. Please try again.",
      },
      { error: "internal_server_error" },
    );
  });

  app.notFound((c) =>
    errorResponse(
      c,
      {
        status: 404,
        code: "not_found",
        title: "Page not found",
        message: "There is no page at this address.",
      },
      { error: "not_found" },
    ),
  );

  // Resolve two IPs (§12.5): `peerIp` is the real TCP socket peer — the immediate
  // hop — used for the trusted-proxy identity gate, NEVER from a header. `clientIp`
  // is the real end-client, taken from X-Forwarded-For ONLY when the peer is a
  // configured trusted proxy (else it equals the peer). clientIp keys login
  // throttling + audit logs; peerIp gates trust. See http/client-ip.ts.
  const extractPeerIp = deps.peerIp ?? ((c) => getConnInfo(c).remote.address);
  const trustedProxyIps = deps.config.auth.proxy.trustedProxyIps;
  app.use("*", async (c, next) => {
    const peer = extractPeerIp(c);
    if (peer) c.set("peerIp", peer);
    const client = resolveClientIp(peer, c.req.header("x-forwarded-for"), trustedProxyIps);
    if (client) c.set("clientIp", client);
    await next();
  });

  // Public health check.
  app.get("/healthz", async (c) => {
    const health = await checkHealth(deps.db);
    return c.json(health, health.status === "ok" ? 200 : 503);
  });

  // Public legal pages (`/privacy`, `/terms`) — mounted BEFORE the auth gateway so
  // the Google OAuth consent screen's reviewers can open them while signed out.
  app.route("/", legalRoutes());

  // Public docs surface (`/docs/*`, `/docs/search.js`, `/llms.txt`) — also before
  // the gateway so signed-out agents and OSS browsers can read it on every host.
  // `/llms.txt` here REPLACES the formerly-private one in serve-sdk.ts (U4).
  app.route("/", docsRoutes());

  // Login throttle (§12.3) — pre-gateway, keyed by the resolved real client IP
  // (`clientIp`: the socket peer, or the X-Forwarded-For client when behind a
  // configured trusted proxy — so it is per-user even behind Caddy, not one global
  // bucket). Defends the credential surface (§12.0 #1). Path-scoped to the login
  // endpoint (oidc-only; a 404 no-op in proxy/dev mode — proxy mode delegates
  // login to the IAP). Set CANVAS_DROP_TRUSTED_PROXY_IPS to your proxy's egress
  // for per-user bucketing; without it the peer (the proxy) is the bucket.
  app.use("/auth/login", async (c, next) => {
    if (deps.config.rateLimit.enabled) {
      const ip = c.get("clientIp") ?? "unknown";
      const r = takeToken(rlStore, `login:${ip}`, deps.config.rateLimit.loginPerMin);
      if (!r.allowed) {
        c.header("Retry-After", String(r.retryAfterSec));
        return c.json({ error: "rate_limited" }, 429);
      }
    }
    await next();
  });

  // Public session-login routes.
  app.route("/auth", authRoutes({ sessionSvc: noopSession(deps.sessionSvc), oidc: deps.oidc }));

  // Bearer-key deploy API — its own auth, BEFORE the session gateway.
  app.route(
    "/v1/canvases",
    deployApiRoutes({
      config: deps.config,
      canvases: deps.canvases,
      versions: deps.versions,
      engine: deps.engine,
      audit: deps.audit,
      rateLimitStore: rlStore,
    }),
  );

  // CORS preflight for the canvas runtime API (§9.4) — answered BEFORE the gateway,
  // since preflights carry no credentials and must not 401.
  app.options("/v1/c/:slug/*", canvasApiPreflight(deps.config));

  // Everything below requires an org session/identity (login on every request).
  app.use(
    "*",
    authGateway({
      strategy: deps.strategy,
      config: deps.config,
      users: deps.users,
      audit: deps.audit,
    }),
  );

  // Classify the request once; canvas middlewares key off the role.
  app.use("*", async (c, next) => {
    const { role, canvasSlug } = resolveRequest(
      { host: c.req.header("host") ?? "", pathname: c.req.path },
      deps.config,
    );
    c.set("role", role);
    if (canvasSlug) c.set("canvasSlug", canvasSlug);
    await next();
  });

  // Broad route-class rate limiting (§6.11.2, §12.3, M7). AFTER the gateway +
  // role middleware so `user`/`canvasSlug` are server-resolved (the keys are
  // never client-asserted, §12.0 #1), BEFORE the route handlers. One path-first
  // classifier covers every runtime + management API class and auto-covers any
  // future AI/realtime HTTP routes.
  app.use("*", rateLimit(rlStore, deps.config));

  // Canvas-facing runtime API (areas F/G/I — KV, files, me). Path-mounted so it
  // handles `/v1/c/:slug/*` ahead of the canvas-content chain; isolation + CORS +
  // capability gating live inside it (§11.4, plan 007 / M6).
  app.route(
    "/v1/c/:slug",
    canvasApiRoutes({
      config: deps.config,
      canvases: deps.canvases,
      kv: kvRepository(deps.db),
      files: filesService({
        files: filesRepository(deps.db),
        storage: deps.storage,
        quota: settingsSvc.effectiveQuota,
      }),
      usage: usageEventsRepository(deps.db),
      audit: deps.audit,
      quota: settingsSvc.effectiveQuota,
      aiUsage: aiUsageRepository(deps.db),
      aiProvider: deps.aiProvider ?? anthropicProvider(deps.config),
      realtime,
    }),
  );

  // Served browser SDK (GET /sdk/v1.js) — behind the gateway (§12.0 #1).
  app.route("/", serveSdkRoutes());

  // Current-user identity for the SPA — its own router (NOT under /api/canvases,
  // whose /:id route would match `me`). Behind the gateway, before the SPA fallback.
  app.route("/api/me", meRoutes({ authMode: deps.config.auth.mode }));

  // Opt-in gallery browse (M8) — its own router (NOT under /api/canvases, whose
  // /:id would shadow a literal `gallery` segment). Behind the gateway; the §12
  // visibility predicate runs per request inside the repo.
  app.route("/api/gallery", galleryRoutes({ config: deps.config, canvases: deps.canvases }));

  // Session-authenticated management API.
  app.route(
    "/api/canvases",
    managementRoutes({
      config: deps.config,
      canvases: deps.canvases,
      versions: deps.versions,
      audit: deps.audit,
      engine: deps.engine,
      usage: usageEventsRepository(deps.db),
      files: filesRepository(deps.db),
      aiUsage: aiUsageRepository(deps.db),
      hub: deps.hub,
    }),
  );

  // Admin-only management surface (§6.10, M7). Behind the gateway; `requireAdmin`
  // (server-resolved isAdmin) gates the whole router. Distinct base from /api/canvases.
  app.route(
    "/api/admin",
    adminRoutes({
      config: deps.config,
      admin: adminRepository(deps.db),
      canvases: deps.canvases,
      versions: deps.versions,
      users: deps.users,
      files: filesRepository(deps.db),
      settings: settingsSvc,
      audit: deps.audit,
    }),
  );

  // In-browser editor / draft API (M5) — same base, distinct paths.
  app.route(
    "/api/canvases",
    draftApiRoutes({
      config: deps.config,
      canvases: deps.canvases,
      versions: deps.versions,
      storage: deps.storage,
      drafts: draftService({
        config: deps.config,
        canvases: deps.canvases,
        versions: deps.versions,
        drafts: deps.drafts,
        storage: deps.storage,
        audit: deps.audit,
        log: deps.rootLogger,
      }),
    }),
  );

  // Canvas content chain (only for the canvas role): authorize → password gate → serve.
  const onlyCanvas = (mw: ReturnType<typeof createMiddleware<AppEnv>>) =>
    createMiddleware<AppEnv>((c, next) => (c.get("role") === "canvas" ? mw(c, next) : next()));

  app.use("*", onlyCanvas(canvasAccess({ canvases: deps.canvases })));
  app.use(
    "*",
    onlyCanvas(passwordGate({ config: deps.config, audit: deps.audit, rateLimitStore: rlStore })),
  );
  app.use(
    "*",
    onlyCanvas(
      serveCanvas({ config: deps.config, versions: deps.versions, storage: deps.storage }),
    ),
  );

  // Dashboard SPA (area E): serve the built assets for the dashboard role, behind
  // the auth gateway above (login-on-every-request holds for the shell itself).
  const dashboard = serveSpa({ config: deps.config, log: deps.rootLogger });
  app.use("*", (c, next) => (c.get("role") === "dashboard" ? dashboard(c, next) : next()));

  // Anything still unhandled (platform-api roles F–R) — not built yet.
  app.all("*", (c) =>
    c.json(
      {
        error: "not_implemented",
        role: c.get("role"),
        canvasSlug: c.get("canvasSlug"),
        message: `${c.get("role")} routing is wired; its handlers arrive in a later plan`,
      },
      404,
    ),
  );

  return app;
}

/** authRoutes needs a SessionService for /logout; in proxy mode there's none. */
function noopSession(svc?: SessionService): SessionService {
  return (
    svc ?? {
      async issue() {},
      async resolveUserId() {
        return null;
      },
      async revoke() {},
    }
  );
}
