import type { Config } from "@canvas-drop/shared";
import { createMiddleware } from "hono/factory";
import { resolveRequest } from "../routing/resolve-request.js";
import type { AppEnv } from "./types.js";

/**
 * Platform routes never answer on a canvas host (§12.0 #4, §12.2).
 *
 * In subdomain mode a canvas page's own fetches to `{slug}.{base}` are same-origin
 * and carry the parent-domain session cookie, so a path-mounted platform router
 * reached there would act with the visitor's authority on behalf of the canvas's
 * code. The platform surface lives on the base host; on a canvas host these
 * prefixes are refused before any router sees them. Canvas content (including the
 * reserved `__canvasdrop_*` paths and the relative `/sdk/v1.js` include) is not
 * listed and continues to the canvas chain.
 *
 * Mounted before the pre-gateway routers (`/auth`, `/v1/canvases`, MCP) so they
 * are covered too. In path mode the canvas role only matches `/c/{slug}/…`, so no
 * listed prefix can occur and the guard is inert.
 */
const PLATFORM_PREFIXES = [
  "/api/me",
  "/api/gallery",
  "/api/canvases",
  "/api/people",
  "/api/teams",
  "/api/admin",
  "/v1",
  "/auth",
  "/mcp",
  "/authorize",
  "/token",
  "/register",
  "/revoke",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
];

const REDIRECTED_PAGES = new Set(["/auth/login", "/auth/accounts"]);

function isPlatformPath(path: string): boolean {
  return PLATFORM_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Paths a dedicated Deploy API host (`CANVAS_DROP_API_BASE_URL`) answers. */
function isDeployApiPath(path: string): boolean {
  return path === "/healthz" || path === "/v1/canvases" || path.startsWith("/v1/canvases/");
}

export function canvasHostGuard(config: Config) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const { role } = resolveRequest(
      { host: c.req.header("host") ?? "", pathname: c.req.path },
      config,
    );
    // A dedicated Deploy API host serves the keyed Deploy API only: the dashboard,
    // sign-in, MCP and runtime API stay on the base host.
    if (role === "deploy-api") {
      if (isDeployApiPath(c.req.path)) return next();
      return c.json({ error: "not_found" }, 404);
    }
    if (role !== "canvas" || !isPlatformPath(c.req.path)) return next();
    // Two sign-in pages are reached from canvas hosts by navigation: the gateway sends
    // a signed-out visitor to a relative `/auth/login`, and the account chooser has
    // always bounced to the base host. Carry those GETs there instead of serving them.
    const isNav = c.req.method === "GET" || c.req.method === "HEAD";
    if (isNav && REDIRECTED_PAGES.has(c.req.path)) {
      const search = new URL(c.req.url).search;
      return c.redirect(`${config.baseUrl.replace(/\/$/, "")}${c.req.path}${search}`, 302);
    }
    return c.json({ error: "not_found" }, 404);
  });
}
