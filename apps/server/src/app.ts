import type { Config } from "@canvas-drop/shared";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { UpgradeWebSocket } from "hono/ws";
import { adminSettingsService } from "./admin/settings-service.js";
import { anthropicProvider, type ModelProvider } from "./ai/provider.js";
import type { AuditLog } from "./audit/audit-log.js";
import { authGateway } from "./auth/gateway.js";
import type { GuestService } from "./auth/guest.js";
import { guestPublicResolver, onlyWhenNoPrincipal } from "./auth/guest-public-resolver.js";
import { guestRoutes } from "./auth/guest-routes.js";
import { authRoutes } from "./auth/routes.js";
import { SESSION_COOKIE, type SessionService } from "./auth/session.js";
import type { AuthStrategy } from "./auth/strategy.js";
import { canvasAccess } from "./canvas/authorization.js";
import { cloneService } from "./canvas/clone-service.js";
import { filesService } from "./canvas/files-service.js";
import { passwordGate } from "./canvas/password-gate.js";
import { serveCanvas } from "./canvas/serve.js";
import { canvasUrl } from "./canvas/url.js";
import { serveSpa } from "./dashboard/serve-spa.js";
import type { DbClient } from "./db/factory.js";
import { adminRepository } from "./db/repositories/admin.js";
import { aiUsageRepository } from "./db/repositories/ai-usage.js";
import {
  type AllowedEmailsRepository,
  allowedEmailsRepository,
} from "./db/repositories/allowed-emails.js";
import type { CanvasesRepository } from "./db/repositories/canvases.js";
import type { DraftsRepository } from "./db/repositories/drafts.js";
import { filesRepository } from "./db/repositories/files.js";
import { kvRepository } from "./db/repositories/kv.js";
import { oauthRepository } from "./db/repositories/oauth.js";
import { screenshotsRepository } from "./db/repositories/screenshots.js";
import { settingsRepository } from "./db/repositories/settings.js";
import { uploadSessionsRepository } from "./db/repositories/upload-sessions.js";
import { usageEventsRepository } from "./db/repositories/usage-events.js";
import type { UsersRepository } from "./db/repositories/users.js";
import type { VersionsRepository } from "./db/repositories/versions.js";
import type { DeployEngine } from "./deploy/engine.js";
import { docsRoutes } from "./docs/routes.js";
import { draftService } from "./draft/service.js";
import type { Mailer } from "./email/mailer.js";
import { checkHealth } from "./health.js";
import { brandAssetRoutes } from "./http/brand-assets.js";
import { canvasApiPreflight } from "./http/canvas-api-isolation.js";
import { resolveClientIp } from "./http/client-ip.js";
import { errorPageMiddleware, errorResponse } from "./http/error-pages.js";
import { landingGate, landingResponse } from "./http/landing-page.js";
import { legalRoutes } from "./http/legal-pages.js";
import {
  inProcessRateLimitStore,
  type RateLimitStore,
  rateLimit,
  takeToken,
} from "./http/rate-limit.js";
import { securityHeadersMiddleware } from "./http/security-headers.js";
import { socialPreview } from "./http/social-preview.js";
import type { AppEnv } from "./http/types.js";
import type { Logger } from "./log/logger.js";
import { requestLogger } from "./log/middleware.js";
import { mcpRoutes } from "./mcp/routes.js";
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
import { captureResolver } from "./screenshots/capture-resolver.js";
import { PREVIEW_ASSET_PATH, servePreview } from "./screenshots/serve.js";
import { screenshotTrigger } from "./screenshots/trigger.js";
import type { StorageDriver } from "./storage/driver.js";
import { uploadService } from "./upload/service.js";

export interface BuildAppDeps {
  config: Config;
  db: DbClient;
  rootLogger: Logger;
  strategy: AuthStrategy;
  users: UsersRepository;
  /** Admin-managed individual sign-in allowlist (D14 supplement to env domains).
   *  Optional: defaults to a repo over `db` (so tests that omit it get the real,
   *  empty allowlist — domain-only sign-in, the legacy behavior). */
  allowedEmails?: AllowedEmailsRepository;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  drafts: DraftsRepository;
  storage: StorageDriver;
  engine: DeployEngine;
  audit: AuditLog;
  sessionSvc?: SessionService;
  /** Guest magic-link service (U6/U7). Present in oidc/dev; enables the carve-out. */
  guests?: GuestService;
  /** Mailer for guest invites (U8). Present in oidc/dev. */
  mailer?: Mailer;
  oidc?: Parameters<typeof authRoutes>[0]["oidc"];
  /** Override the socket-peer-IP extractor (tests inject a fixed peer). */
  peerIp?: (c: import("hono").Context<AppEnv>) => string | undefined;
  /** Inject a rate-limit store (tests use a fake clock); defaults to in-process. */
  rateLimitStore?: RateLimitStore;
  /** Env vars explicitly set (from `presentEnvVars()` at boot) — admin config source labels. */
  envPresent?: Set<string>;
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

  // The individual sign-in allowlist (D14 supplement). Resolve once: callers may
  // inject one, else build a repo over `db` (an empty allowlist = domain-only).
  const allowedEmails = deps.allowedEmails ?? allowedEmailsRepository(deps.db);

  // Admin-tunable global quota defaults (M7, §6.10.4) over the settings store.
  // `effectiveQuota` is the resolver the KV/files primitives read (settings
  // override ?? their hard constant); admin reads/writes go through the same svc.
  const settingsSvc = adminSettingsService({
    settings: settingsRepository(deps.db),
    config: deps.config,
    // Which env vars were set — for the admin Configuration view's source labels.
    envPresent: deps.envPresent,
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

  // Public favicon / brand icons (`/favicon.svg`, `/site.webmanifest`, `/brand/*`).
  // Pre-gateway so the signed-out landing/legal/docs pages + crawlers get an icon
  // (the SPA serves the same files, but behind the gateway they'd 302 to login).
  app.route("/", brandAssetRoutes());

  // Public legal pages (`/privacy`, `/terms`) — mounted BEFORE the auth gateway so
  // the Google OAuth consent screen's reviewers can open them while signed out.
  app.route("/", legalRoutes(deps.config));

  // Public marketing landing, always-on alias (`/welcome`). Unlike `/` — which is
  // session-branched by `landingGate` so signed-in members get the dashboard — this
  // path ALWAYS renders the landing, so the in-app "About" link and the post-logout
  // redirect can reach the marketing page regardless of session. Pre-gateway.
  app.get("/welcome", (c) =>
    landingResponse(deps.config, { signedIn: !!getCookie(c, SESSION_COOKIE) }),
  );

  // Public docs surface (`/docs/*`, `/docs/search.js`, `/llms.txt`) — also before
  // the gateway so signed-out agents and OSS browsers can read it on every host.
  // `/llms.txt` here REPLACES the formerly-private one in serve-sdk.ts (U4).
  app.route("/", docsRoutes(deps.config));

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

  // Public guest magic-link routes (U8) — pre-gateway (no org session). GET renders
  // a landing page that does NOT consume the token; a same-origin POST consumes it.
  if (deps.guests) {
    app.route(
      "/",
      guestRoutes({
        config: deps.config,
        guests: deps.guests,
        canvases: deps.canvases,
        audit: deps.audit,
        rateLimitStore: rlStore,
      }),
    );
  }

  // Two-channel staging upload service (plan 003) — shared by the Bearer-key
  // deploy API and the MCP surface, over one content-addressed core.
  const upload = uploadService({
    config: deps.config,
    canvases: deps.canvases,
    users: deps.users,
    uploadSessions: uploadSessionsRepository(deps.db),
    storage: deps.storage,
    engine: deps.engine,
  });

  // Bearer-key deploy API — its own auth, BEFORE the session gateway.
  app.route(
    "/v1/canvases",
    deployApiRoutes({
      config: deps.config,
      canvases: deps.canvases,
      versions: deps.versions,
      engine: deps.engine,
      audit: deps.audit,
      storage: deps.storage,
      rateLimitStore: rlStore,
      hub: deps.hub,
      upload,
    }),
  );

  // Remote MCP surface (agent control plane) — OAuth AS + `/mcp`, its own auth,
  // BEFORE the session gateway. Default on; mounted only when enabled so disabling
  // it removes the routes entirely rather than 403'ing them.
  if (deps.config.mcp.enabled) {
    app.route(
      "/",
      mcpRoutes({
        config: deps.config,
        strategy: deps.strategy,
        users: deps.users,
        allowedEmails,
        oauth: oauthRepository(deps.db),
        canvases: deps.canvases,
        versions: deps.versions,
        engine: deps.engine,
        upload,
        storage: deps.storage,
        guests: deps.guests,
        mailer: deps.mailer,
        clone: cloneService({
          canvases: deps.canvases,
          versions: deps.versions,
          drafts: deps.drafts,
          storage: deps.storage,
        }),
        drafts: draftService({
          config: deps.config,
          canvases: deps.canvases,
          versions: deps.versions,
          drafts: deps.drafts,
          storage: deps.storage,
          audit: deps.audit,
          log: deps.rootLogger,
        }),
        usage: usageEventsRepository(deps.db),
        files: filesRepository(deps.db),
        aiUsage: aiUsageRepository(deps.db),
        audit: deps.audit,
        // OAuth-lifecycle events (authorize/token issue+revoke) into the audit log.
        oauthAudit: {
          record: (e) =>
            deps.audit.recordAudit({
              action: e.action,
              actorId: e.actorId,
              ip: e.ip,
              meta: e.reason ? { reason: e.reason } : undefined,
            }),
        },
        rateLimitStore: rlStore,
        hub: deps.hub,
        screenshotsEnabled: () => settingsSvc.effectiveScreenshotsEnabled(),
        screenshots: screenshotsRepository(deps.db),
      }),
    );
  }

  // CORS preflight for the canvas runtime API (§9.4) — answered BEFORE the gateway,
  // since preflights carry no credentials and must not 401.
  app.options("/v1/c/:slug/*", canvasApiPreflight(deps.config));

  // Signed-out link unfurls (iMessage/Slack/…) carry no session cookie, so without
  // this they'd follow the gateway's login redirect and preview the IdP's "Sign in"
  // page. Intercept those HTML navigations BEFORE the gateway and serve a generic
  // Open Graph card pointing at /og.png; real humans are redirected on to login.
  // Guest/public carve-out (U7): runs BEFORE socialPreview + the gateway, derives
  // the role itself, and sets a guest/anonymous principal for canvas surfaces so
  // those requests skip the org gateway. Mounted only in app-gated modes
  // (oidc/dev) — in proxy mode the IAP authenticates first, so it isn't mounted
  // and a forged guest cookie still hits the gateway (KTD7).
  // Internal capture carve-out (plan 004 / U5): establishes the `capture` principal for
  // the screenshot worker's HMAC-token'd requests, in EVERY mode (the token is
  // unforgeable, so it's safe; in proxy mode it's how the loopback worker gets past the
  // IAP gateway). Mounted before the guest carve-out + gateway; decideCanvasAccess gates.
  app.use("*", captureResolver({ config: deps.config, secret: deps.config.sessionSecret }));

  if (deps.config.auth.mode !== "proxy" && deps.guests) {
    app.use(
      "*",
      guestPublicResolver({
        config: deps.config,
        guests: deps.guests,
        canvases: deps.canvases,
      }),
    );
  }

  // Public marketing front door: a signed-out `GET /` renders the landing page
  // (oidc mode only). Mounted BEFORE socialPreview so crawlers scrape the real,
  // indexable landing HTML (with its own OG tags) rather than the generic unfurl
  // card. Signed-in visitors and every non-root path fall straight through.
  app.use("*", landingGate({ config: deps.config }));

  app.use(
    "*",
    socialPreview(deps.config, deps.canvases, async (canvas) => {
      // Per-canvas OG image (plan 004 / U9), public_link only (this resolver is only
      // consulted on the anonymous card). Only when enabled AND a preview is captured;
      // cache-bust by the captured version. Else null → branded /og.png.
      if (!(await settingsSvc.effectiveScreenshotsEnabled())) return null;
      const job = await screenshotsRepository(deps.db).findByCanvas(canvas.id);
      if (job?.status !== "done") return null;
      return `${canvasUrl(deps.config, canvas.slug)}${PREVIEW_ASSET_PATH}?rendition=og&v=${encodeURIComponent(job.versionId)}`;
    }),
  );

  // Everything below requires an org session/identity (login on every request) —
  // UNLESS the carve-out above already set a guest/anonymous principal, in which
  // case the gateway steps aside (onlyWhenNoPrincipal) and authorization is left
  // to decideCanvasAccess (the sole gate).
  app.use(
    "*",
    onlyWhenNoPrincipal(
      authGateway({
        strategy: deps.strategy,
        config: deps.config,
        users: deps.users,
        allowedEmails,
        audit: deps.audit,
      }),
    ),
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
      // Tests inject a ready provider; production builds one per request from the
      // EFFECTIVE key (admin DB override ?? env) via the factory + settings service.
      aiProvider: deps.aiProvider,
      makeAiProvider: (apiKey) => anthropicProvider({ apiKey, baseUrl: deps.config.ai.baseUrl }),
      settings: settingsSvc,
      realtime,
    }),
  );

  // Served browser SDK (GET /sdk/v1.js) — behind the gateway (§12.0 #1).
  app.route("/", serveSdkRoutes());

  // Current-user identity for the SPA — its own router (NOT under /api/canvases,
  // whose /:id route would match `me`). Behind the gateway, before the SPA fallback.
  app.route(
    "/api/me",
    meRoutes({
      authMode: deps.config.auth.mode,
      urlMode: deps.config.urlMode,
      baseUrl: deps.config.baseUrl,
    }),
  );

  // Opt-in gallery browse (M8) — its own router (NOT under /api/canvases, whose
  // /:id would shadow a literal `gallery` segment). Behind the gateway; the §12
  // visibility predicate runs per request inside the repo.
  app.route(
    "/api/gallery",
    galleryRoutes({
      config: deps.config,
      canvases: deps.canvases,
      screenshotsEnabled: () => settingsSvc.effectiveScreenshotsEnabled(),
      screenshots: screenshotsRepository(deps.db),
    }),
  );

  // Session-authenticated management API.
  app.route(
    "/api/canvases",
    managementRoutes({
      config: deps.config,
      canvases: deps.canvases,
      users: deps.users,
      versions: deps.versions,
      clone: cloneService({
        canvases: deps.canvases,
        versions: deps.versions,
        drafts: deps.drafts,
        storage: deps.storage,
      }),
      audit: deps.audit,
      engine: deps.engine,
      storage: deps.storage,
      usage: usageEventsRepository(deps.db),
      files: filesRepository(deps.db),
      aiUsage: aiUsageRepository(deps.db),
      hub: deps.hub,
      guests: deps.guests,
      mailer: deps.mailer,
      // Effective operator globals (admin DB override ?? env) for the capabilities view.
      aiEnabled: () => settingsSvc.aiEnabled(),
      realtimeEnabled: () => settingsSvc.effectiveRealtimeEnabled(),
      // Screenshot preview support (plan 004) for the dashboard `hasPreview` cover hint.
      screenshotsEnabled: () => settingsSvc.effectiveScreenshotsEnabled(),
      screenshots: screenshotsRepository(deps.db),
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
      aiUsage: aiUsageRepository(deps.db),
      settings: settingsSvc,
      allowedEmails,
      audit: deps.audit,
      revokeMcpTokensForUser: (id) => oauthRepository(deps.db).tokens.revokeAllForUser(id),
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
        // Schedule screenshot captures on publish (plan 004 / U6); the worker consumes
        // them. Only wired when the pipeline is enabled.
        // Effective-gated, best-effort capture trigger (plan 004 / U12). Always wired —
        // it self-gates on env-available AND admin-enabled, so when off it's a no-op.
        screenshots: screenshotTrigger({
          enabled: () => settingsSvc.effectiveScreenshotsEnabled(),
          repo: screenshotsRepository(deps.db),
          log: deps.rootLogger,
        }),
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
  // Access-gated preview serving (plan 004 / U7): a reserved path on the canvas surface,
  // AFTER access + password gate, so a private canvas's cover is only served to a
  // requester decideCanvasAccess already allowed. 404s (→ GenerativeCover) when off or
  // not yet captured. Falls through to serveCanvas for all real content paths.
  app.use(
    "*",
    onlyCanvas(
      servePreview({
        config: deps.config,
        storage: deps.storage,
        enabled: () => settingsSvc.effectiveScreenshotsEnabled(),
      }),
    ),
  );
  app.use(
    "*",
    onlyCanvas(
      serveCanvas({
        config: deps.config,
        versions: deps.versions,
        storage: deps.storage,
        usage: usageEventsRepository(deps.db),
        log: deps.rootLogger,
      }),
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
