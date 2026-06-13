import type { Config } from "@canvas-drop/shared";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AuditLog } from "./audit/audit-log.js";
import { authGateway } from "./auth/gateway.js";
import { authRoutes } from "./auth/routes.js";
import type { SessionService } from "./auth/session.js";
import type { AuthStrategy } from "./auth/strategy.js";
import { canvasAccess } from "./canvas/authorization.js";
import { passwordGate } from "./canvas/password-gate.js";
import { serveCanvas } from "./canvas/serve.js";
import { serveSpa } from "./dashboard/serve-spa.js";
import type { DbClient } from "./db/factory.js";
import type { CanvasesRepository } from "./db/repositories/canvases.js";
import type { UsersRepository } from "./db/repositories/users.js";
import type { VersionsRepository } from "./db/repositories/versions.js";
import type { DeployEngine } from "./deploy/engine.js";
import { checkHealth } from "./health.js";
import type { AppEnv } from "./http/types.js";
import type { Logger } from "./log/logger.js";
import { requestLogger } from "./log/middleware.js";
import { deployApiRoutes } from "./routes/deploy-api.js";
import { managementRoutes } from "./routes/management.js";
import { meRoutes } from "./routes/me.js";
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
  storage: StorageDriver;
  engine: DeployEngine;
  audit: AuditLog;
  sessionSvc?: SessionService;
  oidc?: Parameters<typeof authRoutes>[0]["oidc"];
  /** Override the peer-IP extractor (tests inject a fixed IP). */
  clientIp?: (c: import("hono").Context<AppEnv>) => string | undefined;
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

  app.use("*", requestLogger(deps.rootLogger));

  // Resolve the client IP for trusted-proxy checks (§12.5). MUST be the real TCP
  // socket peer — NOT X-Forwarded-For / X-Real-IP (client-settable).
  const extractIp = deps.clientIp ?? ((c) => getConnInfo(c).remote.address);
  app.use("*", async (c, next) => {
    const ip = extractIp(c);
    if (ip) c.set("clientIp", ip);
    await next();
  });

  // Public health check.
  app.get("/healthz", async (c) => {
    const health = await checkHealth(deps.db);
    return c.json(health, health.status === "ok" ? 200 : 503);
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
    }),
  );

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

  // Current-user identity for the SPA — its own router (NOT under /api/canvases,
  // whose /:id route would match `me`). Behind the gateway, before the SPA fallback.
  app.route("/api/me", meRoutes());

  // Session-authenticated management API.
  app.route(
    "/api/canvases",
    managementRoutes({
      config: deps.config,
      canvases: deps.canvases,
      versions: deps.versions,
      audit: deps.audit,
      engine: deps.engine,
    }),
  );

  // Canvas content chain (only for the canvas role): authorize → password gate → serve.
  const onlyCanvas = (mw: ReturnType<typeof createMiddleware<AppEnv>>) =>
    createMiddleware<AppEnv>((c, next) => (c.get("role") === "canvas" ? mw(c, next) : next()));

  app.use("*", onlyCanvas(canvasAccess({ canvases: deps.canvases })));
  app.use("*", onlyCanvas(passwordGate({ config: deps.config, audit: deps.audit })));
  app.use(
    "*",
    onlyCanvas(
      serveCanvas({ config: deps.config, versions: deps.versions, storage: deps.storage }),
    ),
  );

  // Dashboard SPA (area E): serve the built assets for the dashboard role, behind
  // the auth gateway above (login-on-every-request holds for the shell itself).
  const dashboard = serveSpa({ config: deps.config });
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
