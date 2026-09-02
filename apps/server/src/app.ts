import type { Config } from "@canvas-drop/shared";
import type { Manifest } from "@canvas-drop/shared/db";
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
import { guestRoutes } from "./auth/guest-routes.js";
import { makeOrgMembershipResolver } from "./auth/org-membership.js";
import { onlyWhenNoPrincipal, publicCanvasResolver } from "./auth/public-canvas-resolver.js";
import { authRoutes } from "./auth/routes.js";
import { SESSION_COOKIE, type SessionService } from "./auth/session.js";
import type { AuthStrategy } from "./auth/strategy.js";
import { resolveAsset } from "./canvas/asset-resolver.js";
import { canvasAccess } from "./canvas/authorization.js";
import { filesService } from "./canvas/files-service.js";
import { passwordGate } from "./canvas/password-gate.js";
import { serveCanvas } from "./canvas/serve.js";
import { blobKey } from "./canvas/storage-keys.js";
import { canvasUrl } from "./canvas/url.js";
import { connectionLimits } from "./connections/limits.js";
import { createSecretCipher } from "./connections/secret-cipher.js";
import { connectionService } from "./connections/service.js";
import {
  connectionTransport as makeConnectionTransport,
  nodeConnectionRequest,
  resolveConnectionHost,
} from "./connections/transport.js";
import { serveSpa } from "./dashboard/serve-spa.js";
import type { DbClient } from "./db/factory.js";
import { adminRepository } from "./db/repositories/admin.js";
import {
  type AllowedEmailsRepository,
  allowedEmailsRepository,
} from "./db/repositories/allowed-emails.js";
import { authoringUsageRepository } from "./db/repositories/authoring-usage.js";
import type { CanvasesRepository } from "./db/repositories/canvases.js";
import { connectionsRepository } from "./db/repositories/connections.js";
import type { DraftsRepository } from "./db/repositories/drafts.js";
import { emailTemplatesRepository } from "./db/repositories/email-templates.js";
import { invitationsRepository } from "./db/repositories/invitations.js";
import { kvRepository } from "./db/repositories/kv.js";
import { type OrgMembersRepository, orgMembersRepository } from "./db/repositories/org-members.js";
import { type OrgsRepository, orgsRepository } from "./db/repositories/orgs.js";
import { settingsRepository } from "./db/repositories/settings.js";
import { teamsRepository } from "./db/repositories/teams.js";
import type { UsersRepository } from "./db/repositories/users.js";
import type { VersionsRepository } from "./db/repositories/versions.js";
import type { DeployEngine } from "./deploy/engine.js";
import { docsRoutes } from "./docs/routes.js";
import type { Mailer } from "./email/mailer.js";
import { noopMailer } from "./email/noop.js";
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
import { inviteService } from "./invites/service.js";
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
import { peopleRoutes } from "./routes/people.js";
import { serveSdkRoutes } from "./routes/serve-sdk.js";
import { teamsRoutes } from "./routes/teams.js";
import { resolveRequest } from "./routing/resolve-request.js";
import { captureResolver } from "./screenshots/capture-resolver.js";
import { PREVIEW_ASSET_PATH, servePreview } from "./screenshots/serve.js";
import type { StorageDriver } from "./storage/driver.js";
import { teamsService } from "./teams/service.js";
import { composeServices } from "./wiring.js";

/**
 * Internal marker on the platform sub-app's `notFound` response so the host-scoping
 * guard can distinguish "no platform/marketing route matched this apex request"
 * (→ fall through to the rest of the chain) from a real platform response. Never
 * reaches a client: a sentinel response is always swapped for `next()`.
 */
const PLATFORM_MISS_HEADER = "x-canvas-drop-platform-miss";
const PLATFORM_MISS_HEADERS = { [PLATFORM_MISS_HEADER]: "1" };

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
  /** Tenancy org store (plan 002 U3). Optional: defaults to a repo over `db` (tests
   *  that omit it get an empty orgs table → every member resolves to ∅, the legacy
   *  org-agnostic behavior). */
  orgs?: OrgsRepository;
  /** Explicit org-membership store (plan 003 U2). Optional: defaults to a repo over
   *  `db`. Materialized at login by the membership resolver; the real-time boundary
   *  stays the live resolver, so this table is roster/reconcile bookkeeping. */
  orgMembers?: OrgMembersRepository;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  drafts: DraftsRepository;
  storage: StorageDriver;
  engine: DeployEngine;
  audit: AuditLog;
  sessionSvc?: SessionService;
  /** Legacy guest service. Retained for cutover/revocation compatibility only. */
  guests?: GuestService;
  /** Mailer for sign-in and access emails. */
  mailer?: Mailer;
  oidc?: Parameters<typeof authRoutes>[0]["oidc"];
  /** Override the socket-peer-IP extractor (tests inject a fixed peer). */
  peerIp?: (c: import("hono").Context<AppEnv>) => string | undefined;
  /** Inject a rate-limit store (tests use a fake clock); defaults to in-process. */
  rateLimitStore?: RateLimitStore;
  /** Outbound connection transport seam; tests inject a no-network fake. */
  connectionTransport?: ReturnType<typeof makeConnectionTransport>;
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
  // Admin-editable email templates (plan 003 phase 3). Boot seeds the defaults (index.ts).
  const emailTemplates = emailTemplatesRepository(deps.db);

  // Tenancy org store + the membership resolver (plan 002 U3). Default to a repo over
  // `db`: tests/callers that omit `orgs` get the real, empty orgs table → every member
  // resolves to ∅, i.e. the legacy org-agnostic `whole_org` behavior.
  const orgs = deps.orgs ?? orgsRepository(deps.db);
  const orgMembers = deps.orgMembers ?? orgMembersRepository(deps.db);
  const orgMembership = makeOrgMembershipResolver(orgs, orgMembers);

  // Teams (plan 003 P2): the repo + the authz-bearing service the routes AND MCP wrap.
  // The service is constructed below, once the invite primitive it depends on exists.
  const teams = teamsRepository(deps.db);

  // Pending invitations (plan 003 U4): grants recorded before the invitee has a user row,
  // materialized on their first verified login (see authGateway below).
  const invitations = invitationsRepository(deps.db);

  // Admin-tunable global quota defaults (M7, §6.10.4) over the settings store.
  // `effectiveQuota` is the resolver the KV/files primitives read (settings
  // override ?? their hard constant); admin reads/writes go through the same svc.
  const settingsSvc = adminSettingsService({
    settings: settingsRepository(deps.db),
    config: deps.config,
    // Which env vars were set — for the admin Configuration view's source labels.
    envPresent: deps.envPresent,
  });
  const connections = connectionService({
    repository: connectionsRepository(deps.db),
    canvases: deps.canvases,
    cipher: createSecretCipher(deps.config.connections.encryptionKey),
    audit: deps.audit,
  });
  const connectionHttp =
    deps.connectionTransport ??
    makeConnectionTransport({ resolve: resolveConnectionHost, request: nodeConnectionRequest });
  const connectionAdmission = connectionLimits(deps.config.connections);

  // One shared in-process rate-limit store (§9.7, M7) — used by the broad
  // post-gateway middleware AND the out-of-band mount points (Bearer deploy,
  // login, password-gate) so MAX_KEYS bounds everything. Per-buildApp = per-test
  // isolation.
  const rlStore = deps.rateLimitStore ?? inProcessRateLimitStore();

  // The invite primitive (plan 003 U5): ONE shared layer every owner-facing invite surface
  // (team add, canvas add/invite, admin Add-users) routes through — rate-limit → resolve →
  // grant-now-or-record-pending → notify, with the KTD5 new-email permit gate. Wraps the same
  // services/repos the routes use. `noopMailer` keeps `canSend` false when email is
  // unconfigured (grants still apply; no courtesy mail).
  const mailer = deps.mailer ?? noopMailer();
  const invites = inviteService({
    config: deps.config,
    users: deps.users,
    allowedEmails,
    invitations,
    teams,
    canvases: deps.canvases,
    orgs,
    settings: settingsSvc,
    templates: emailTemplates,
    mailer,
    rateLimitStore: rlStore,
    log: deps.rootLogger,
  });

  // The team service depends on the invite primitive (personal-team adds route through it).
  const teamsSvc = teamsService({
    teams,
    orgMembers,
    users: deps.users,
    invites,
    invitations,
    audit: deps.audit,
  });

  // Obtain the WebSocket upgrade helper for THIS app instance (chicken-and-egg:
  // @hono/node-ws needs the app; the route needs the helper). Realtime is wired
  // only when both the helper and the hub are present.
  const upgradeWebSocket = deps.registerWebSocket?.(app);
  const realtime = upgradeWebSocket && deps.hub ? { hub: deps.hub, upgradeWebSocket } : undefined;

  // Stash typed config on every request's context FIRST, so surfaces that render
  // outside a route closure — the branded error pages, which need the dashboard
  // origin + auth mode to build a working "Open dashboard" link (absolute, since a
  // canvas subdomain's `/` is the canvas, not the dashboard) — can read it. Set
  // before errorPageMiddleware so it's present when that middleware post-processes.
  app.use("*", async (c, next) => {
    c.set("config", deps.config);
    await next();
  });

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
  // Optional CDN real-client header (e.g. True-Client-IP) — read only when the peer is
  // a trusted proxy, inside resolveClientIp. Normalized to lowercase at config load.
  const clientIpHeader = deps.config.auth.proxy.clientIpHeader;
  app.use("*", async (c, next) => {
    const peer = extractPeerIp(c);
    if (peer) c.set("peerIp", peer);
    const cdnClientIp = clientIpHeader ? c.req.header(clientIpHeader) : undefined;
    const client = resolveClientIp(
      peer,
      c.req.header("x-forwarded-for"),
      trustedProxyIps,
      cdnClientIp,
    );
    if (client) c.set("clientIp", client);
    await next();
  });

  // Public health check.
  app.get("/healthz", async (c) => {
    const health = await checkHealth(deps.db);
    return c.json(health, health.status === "ok" ? 200 : 503);
  });

  // ── Platform / marketing surface — apex host ONLY (pre-gateway) ────────────
  // The platform's OWN public pages: favicon/brand icons + fonts (brandAssets),
  // legal (`/privacy`, `/terms`), the `/welcome` landing alias, and docs
  // (`/docs/*`, `/og.png`, `/llms.txt`, `/skill.zip`). Mounted BEFORE the auth
  // gateway so signed-out crawlers/agents (and Google's OAuth consent reviewers)
  // reach them — but HOST-SCOPED: they must serve only on the platform/apex host
  // (`config.baseUrl`), never shadow a canvas subdomain. On a canvas host these
  // reserved paths belong to the tenant, so its own `/docs`, `/og.png`, … win (or
  // its 404 / SPA fallback) — the same apex-vs-canvas seam `landingGate` uses.
  //
  // The family lives in its own sub-app that the guard DELEGATES to per request,
  // rather than merging into `app`: a merged route would win by registration order
  // even on a canvas host (the shadowing bug this fixes), and there is no way to
  // fall a merged route THROUGH to the later canvas chain. A `notFound` sentinel
  // lets the guard tell "no platform route matched" (→ continue the parent chain,
  // exactly as before on the apex) from a real platform response. In `path` mode
  // every host is the apex and canvases live under `/c/{slug}`, so nothing collides.
  const platform = new Hono<AppEnv>();
  platform.route("/", brandAssetRoutes());
  platform.route("/", legalRoutes(deps.config, { skin: () => settingsSvc.effectiveDesignSkin() }));
  // `/welcome`: unlike `/` (session-branched by `landingGate`) this ALWAYS renders
  // the landing, so the in-app "About" link + the post-logout redirect can reach it.
  platform.get("/welcome", async (c) =>
    landingResponse(deps.config, {
      signedIn: !!getCookie(c, SESSION_COOKIE),
      skin: await settingsSvc.effectiveDesignSkin(),
    }),
  );
  // `/llms.txt` here REPLACES the formerly-private one in serve-sdk.ts (U4).
  platform.route("/", docsRoutes(deps.config, { skin: () => settingsSvc.effectiveDesignSkin() }));
  // Sentinel: no platform route matched → let the guard continue the parent chain.
  platform.notFound(() => new Response(null, { status: 404, headers: PLATFORM_MISS_HEADERS }));

  app.use("*", async (c, next) => {
    // Every platform page is GET/HEAD; skip the delegation for other methods.
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    // A canvas subdomain owns these reserved paths — fall through to the canvas chain.
    const { role } = resolveRequest(
      { host: c.req.header("host") ?? "", pathname: c.req.path },
      deps.config,
    );
    if (role === "canvas") return next();
    const res = await platform.fetch(c.req.raw);
    // Unmatched on the apex → continue the normal chain (login throttle, gateway, SPA…).
    if (res.headers.has(PLATFORM_MISS_HEADER)) return next();
    return res;
  });

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

  // CORS preflight for the canvas runtime API (§9.4) — answered BEFORE the gateway,
  // since preflights carry no credentials and must not 401. In subdomain mode it echoes
  // the validated canvas origin + `Access-Control-Allow-Credentials: true` so the SDK
  // (credentials: "include") can call the base-host API with PUT/DELETE/PATCH.
  //
  // MUST be registered BEFORE the `/`-mounted routers below — the MCP OAuth router
  // (`@hono/mcp` `mcpAuthRouter`) installs a GLOBAL, unconfigured `new Hono().use(cors())`
  // (Hono default: `Access-Control-Allow-Origin: *`, NO credentials) that runs for every
  // path. `cors()` short-circuits OPTIONS preflights with a 204 before route matching, so
  // if MCP mounts first it hijacks this preflight and answers wildcard/no-credentials —
  // which browsers reject for credentialed requests ("Failed to fetch"). Registering this
  // handler earlier lets it claim `/v1/c/:slug/*` OPTIONS first; MCP's cors still serves
  // its own `/mcp` + `/.well-known/*` OPTIONS (different paths). See routes.ts.
  app.options("/v1/c/:slug/*", canvasApiPreflight(deps.config));

  // Public session-login routes.
  app.route("/auth", authRoutes({ sessionSvc: noopSession(deps.sessionSvc), oidc: deps.oidc }));

  // Retired guest magic-link routes — pre-gateway so old emailed URLs get a stable
  // no-store 410 instead of falling through to login or consuming a token.
  app.route("/", guestRoutes({ config: deps.config, rateLimitStore: rlStore }));

  // ── Shared service graph (composition root, §9.1) ─────────────────────────
  // Repositories and services used by MORE THAN ONE route mount are constructed
  // ONCE, in composeServices(), and shared below. Centralizing the graph is what
  // keeps the MCP control plane and the dashboard HTTP routes wrapping the SAME
  // service instances (the agent-native parity rule) — see wiring.ts. (Repos used
  // by exactly one mount — kv, admin, settings, allowedEmails — stay inline at
  // their use site; promote them here if a second consumer appears.)
  const { usage, screenshots, files, aiUsage, oauth, upload, clone, versionHistory, drafts } =
    composeServices({
      config: deps.config,
      db: deps.db,
      log: deps.rootLogger,
      users: deps.users,
      canvases: deps.canvases,
      versions: deps.versions,
      draftsRepo: deps.drafts,
      storage: deps.storage,
      engine: deps.engine,
      audit: deps.audit,
      settings: settingsSvc,
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
        log: deps.rootLogger,
        strategy: deps.strategy,
        users: deps.users,
        orgs,
        orgMembers,
        teams,
        teamsService: teamsSvc,
        invites,
        invitations,
        allowedEmails,
        oauth,
        canvases: deps.canvases,
        versions: deps.versions,
        engine: deps.engine,
        upload,
        storage: deps.storage,
        guests: deps.guests,
        clone,
        versionHistory,
        drafts,
        usage,
        files,
        aiUsage,
        connections,
        audit: deps.audit,
        publicLinksEnabled: () => settingsSvc.effectivePublicLinksEnabled(),
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
        screenshots,
      }),
    );
  }

  // Signed-out link unfurls (iMessage/Slack/…) carry no session cookie, so without
  // this they'd follow the gateway's login redirect and preview the IdP's "Sign in"
  // page. Intercept those HTML navigations BEFORE the gateway and serve a generic
  // Open Graph card pointing at /og.png; real humans are redirected on to login.
  // Public-link carve-out: runs BEFORE socialPreview + the gateway, derives the role itself,
  // and sets only an anonymous principal for public_link canvas surfaces. Legacy guest cookies
  // are intentionally ignored after the guest cutover.
  // Internal capture carve-out (plan 004 / U5): establishes the `capture` principal for
  // the screenshot worker's HMAC-token'd requests, in EVERY mode (the token is
  // unforgeable, so it's safe; in proxy mode it's how the loopback worker gets past the
  // IAP gateway). Mounted before the public-link carve-out + gateway; decideCanvasAccess gates.
  app.use("*", captureResolver({ config: deps.config, secret: deps.config.sessionSecret }));

  app.use(
    "*",
    publicCanvasResolver({
      config: deps.config,
      canvases: deps.canvases,
      publicLinksEnabled: () => settingsSvc.effectivePublicLinksEnabled(),
    }),
  );

  // Public marketing front door: a signed-out `GET /` renders the landing page
  // (oidc mode only). Mounted BEFORE socialPreview so crawlers scrape the real,
  // indexable landing HTML (with its own OG tags) rather than the generic unfurl
  // card. Signed-in visitors and every non-root path fall straight through.
  app.use("*", landingGate({ config: deps.config, skin: () => settingsSvc.effectiveDesignSkin() }));

  app.use(
    "*",
    socialPreview(
      deps.config,
      deps.canvases,
      async (canvas) => {
        // Per-canvas OG image (plan 004 / U9), public_link only (this resolver is only
        // consulted on the anonymous card). Only when enabled AND a preview is captured;
        // cache-bust by the captured version. Else null → branded /og.png.
        if (!(await settingsSvc.effectiveScreenshotsEnabled())) return null;
        const job = await screenshots.findByCanvas(canvas.id);
        if (job?.status !== "done") return null;
        return `${canvasUrl(deps.config, canvas.slug)}${PREVIEW_ASSET_PATH}?rendition=og&v=${encodeURIComponent(job.versionId)}`;
      },
      // Reads the published home document so socialPreview can defer to a canvas that
      // ships its own OG/Twitter tags. Bounded to the <head>-bearing prefix (64 KiB)
      // so a large HTML doc can't turn a crawler unfurl into a big read/decode.
      async (canvas) => {
        if (!canvas.currentVersionId) return null;
        const version = await deps.versions.findById(canvas.currentVersionId);
        if (version?.status !== "ready" || !version.manifest) return null;
        const manifest = version.manifest as Manifest;
        const resolved = resolveAsset(manifest, "", canvas.spaFallback);
        if (!resolved || !/\.html?$/i.test(resolved.path)) return null;
        const entry = manifest[resolved.path];
        if (!entry) return null;
        const bytes = await deps.storage.get(blobKey(canvas.id, entry.hash));
        if (!bytes) return null;
        return new TextDecoder().decode(bytes.subarray(0, 64 * 1024));
      },
    ),
  );

  // Everything below requires an org session/identity (login on every request) —
  // UNLESS the carve-out above already set an anonymous/capture principal, in which
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
        orgMembership,
        invitations: { invitations },
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
      publicLinksEnabled: () => settingsSvc.effectivePublicLinksEnabled(),
      teams,
      kv: kvRepository(deps.db),
      files: filesService({
        files,
        storage: deps.storage,
        quota: settingsSvc.effectiveQuota,
      }),
      usage,
      connections: {
        service: connections,
        transport: connectionHttp,
        limits: connectionAdmission,
      },
      audit: deps.audit,
      quota: settingsSvc.effectiveQuota,
      aiUsage,
      // Tests inject a ready provider; production builds one per request from the
      // EFFECTIVE key (admin DB override ?? env) via the factory + settings service.
      aiProvider: deps.aiProvider,
      makeAiProvider: (apiKey) => anthropicProvider({ apiKey, baseUrl: deps.config.ai.baseUrl }),
      settings: settingsSvc,
      // Authoring primitive (plan 2026-07-04): the viewer-scoped create→deploy→configure
      // route. Reuses the shared deploy engine + a metering repo; the settings service
      // resolves the effective switch + policy (DB override ?? env) per request.
      engine: deps.engine,
      authoringUsage: authoringUsageRepository(deps.db),
      authoringSettings: settingsSvc,
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
      // Effective skin (admin DB override over env/default), resolved per-request so a
      // runtime flip in Admin → Configuration reaches the SPA without a restart.
      designSkin: () => settingsSvc.effectiveDesignSkin(),
      publicLinksEnabled: () => settingsSvc.effectivePublicLinksEnabled(),
      orgs,
      tenancyActive: !!deps.config.org.name,
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
      screenshots,
    }),
  );

  // Session-authenticated management API.
  app.route(
    "/api/canvases",
    managementRoutes({
      config: deps.config,
      canvases: deps.canvases,
      teams,
      users: deps.users,
      versions: deps.versions,
      clone,
      audit: deps.audit,
      engine: deps.engine,
      versionHistory,
      storage: deps.storage,
      usage,
      files,
      aiUsage,
      connections,
      hub: deps.hub,
      guests: deps.guests,
      invites,
      invitations,
      orgMembership,
      // Effective operator globals (admin DB override ?? env) for the capabilities view.
      aiEnabled: () => settingsSvc.aiEnabled(),
      realtimeEnabled: () => settingsSvc.effectiveRealtimeEnabled(),
      authoringEnabled: () => settingsSvc.authoringEnabled(),
      publicLinksEnabled: () => settingsSvc.effectivePublicLinksEnabled(),
      // Screenshot preview support (plan 004) for the dashboard `hasPreview` cover hint.
      screenshotsEnabled: () => settingsSvc.effectiveScreenshotsEnabled(),
      screenshots,
    }),
  );

  // Add person suggestions. Server-scoped to owned canvas / visible team contexts.
  app.route(
    "/api/people",
    peopleRoutes({
      config: deps.config,
      canvases: deps.canvases,
      teams,
      users: deps.users,
      orgMembers,
    }),
  );

  // Team management (plan 003 P2) — session-authenticated, behind the gateway.
  app.route("/api/teams", teamsRoutes({ config: deps.config, service: teamsSvc, teams }));

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
      files,
      aiUsage,
      settings: settingsSvc,
      allowedEmails,
      emailTemplates,
      invitations,
      invites,
      audit: deps.audit,
      connections,
      usage,
      revokeMcpTokensForUser: (id) => oauth.tokens.revokeAllForUser(id),
      orgMembership,
      hub: deps.hub,
    }),
  );

  // In-browser editor / draft API (M5) — same base, distinct paths. Shares the
  // one `drafts` service built above, so the editor and the MCP `publish_draft`
  // tool drive the identical publish path (incl. screenshot capture).
  app.route(
    "/api/canvases",
    draftApiRoutes({
      config: deps.config,
      canvases: deps.canvases,
      versions: deps.versions,
      storage: deps.storage,
      drafts,
    }),
  );

  // Canvas content chain (only for the canvas role): authorize → password gate → serve.
  const onlyCanvas = (mw: ReturnType<typeof createMiddleware<AppEnv>>) =>
    createMiddleware<AppEnv>((c, next) => (c.get("role") === "canvas" ? mw(c, next) : next()));

  app.use(
    "*",
    onlyCanvas(
      canvasAccess({
        canvases: deps.canvases,
        teams,
        tenancyActive: !!deps.config.org.name,
        publicLinksEnabled: () => settingsSvc.effectivePublicLinksEnabled(),
      }),
    ),
  );
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
        usage,
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
