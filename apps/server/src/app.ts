import type { Config } from "@canvas-drop/shared";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import type { AuditLog } from "./audit/audit-log.js";
import { authGateway } from "./auth/gateway.js";
import { authRoutes } from "./auth/routes.js";
import type { SessionService } from "./auth/session.js";
import type { AuthStrategy } from "./auth/strategy.js";
import type { DbClient } from "./db/factory.js";
import type { UsersRepository } from "./db/repositories/users.js";
import { checkHealth } from "./health.js";
import type { AppEnv } from "./http/types.js";
import type { Logger } from "./log/logger.js";
import { requestLogger } from "./log/middleware.js";
import { type RequestRole, resolveRequest } from "./routing/resolve-request.js";

export interface BuildAppDeps {
  config: Config;
  db: DbClient;
  rootLogger: Logger;
  strategy: AuthStrategy;
  users: UsersRepository;
  audit: AuditLog;
  sessionSvc?: SessionService;
  oidc?: Parameters<typeof authRoutes>[0]["oidc"];
  /** Override the peer-IP extractor (tests inject a fixed IP). */
  clientIp?: (c: import("hono").Context<AppEnv>) => string | undefined;
}

/**
 * Compose the single role-routed Hono app (BUILD_BRIEF.md §9.1). Middleware
 * order: correlation-id/log → client-IP → auth gateway. `/healthz` is public;
 * `/auth/*` is public (login lives there); everything else requires auth. Canvas
 * and platform-api roles return an honest "not built yet" until area C/the
 * primitives land — routing is wired ahead of them so U11 proves the seam.
 */
export function buildApp(deps: BuildAppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", requestLogger(deps.rootLogger));

  // Resolve the client IP for trusted-proxy checks (§12.5). MUST be the real TCP
  // socket peer — NOT X-Forwarded-For / X-Real-IP, which are client-settable and
  // would let an attacker spoof a trusted hop and assert an identity header.
  // Behind a proxy the socket peer *is* the proxy, which is exactly the hop we
  // check against CANVAS_DROP_TRUSTED_PROXY_IPS. Tests inject a fixed IP.
  const extractIp = deps.clientIp ?? ((c) => getConnInfo(c).remote.address);
  app.use("*", async (c, next) => {
    const ip = extractIp(c);
    if (ip) c.set("clientIp", ip);
    await next();
  });

  // Public health check — no auth, excluded from request logging (U3).
  app.get("/healthz", async (c) => {
    const health = await checkHealth(deps.db);
    return c.json(health, health.status === "ok" ? 200 : 503);
  });

  // Auth routes are public (login/callback/logout must be reachable unauthenticated).
  app.route("/auth", authRoutes({ sessionSvc: noopSession(deps.sessionSvc), oidc: deps.oidc }));

  // Everything else is behind the gateway (login on every request, §12.1.1).
  app.use(
    "*",
    authGateway({
      strategy: deps.strategy,
      config: deps.config,
      users: deps.users,
      audit: deps.audit,
    }),
  );

  // Role-routed placeholders. Canvas serving (area C) and the platform/management
  // APIs (areas D–R) replace these in later plans; for now they answer honestly.
  app.all("*", (c) => {
    const { role, canvasSlug } = resolveRequest(
      { host: c.req.header("host") ?? "", pathname: c.req.path },
      deps.config,
    );
    return c.json(notBuilt(role, canvasSlug), 404);
  });

  return app;
}

function notBuilt(role: RequestRole, slug?: string) {
  return {
    error: "not_implemented",
    role,
    canvasSlug: slug,
    message: `${role} routing is wired; its handlers arrive in a later plan`,
  };
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
