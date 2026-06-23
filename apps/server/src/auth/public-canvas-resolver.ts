import type { Config } from "@canvas-drop/shared";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { AppEnv } from "../http/types.js";
import { resolveRequest } from "../routing/resolve-request.js";
import { SESSION_COOKIE } from "./session.js";

export interface PublicCanvasResolverDeps {
  config: Config;
  canvases: Pick<CanvasesRepository, "findBySlug">;
}

/**
 * Pre-gateway carve-out for anonymous `public_link` canvases only. Legacy guest
 * cookies are intentionally ignored; authorization still flows through
 * `decideCanvasAccess`, where public viewers remain static-only.
 */
export function publicCanvasResolver(deps: PublicCanvasResolverDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.get("principal")) return next();

    const { role, canvasSlug } = resolveRequest(
      { host: c.req.header("host") ?? "", pathname: c.req.path },
      deps.config,
    );
    if ((role !== "canvas" && role !== "platform-api") || !canvasSlug) return next();

    // If an org session exists, let the normal gateway authenticate the member so
    // owners keep full access and non-owners are classified by the decision table.
    if (getCookie(c, SESSION_COOKIE)) return next();

    const canvas = await deps.canvases.findBySlug(canvasSlug);
    if (canvas && canvas.status === "active" && canvas.access === "public_link") {
      c.set("principal", { kind: "anonymous" });
    }
    return next();
  });
}

/**
 * Wrap the org `authGateway` so it is skipped once an upstream resolver has
 * established a non-org principal. Member requests still run the gateway.
 */
export function onlyWhenNoPrincipal(
  gateway: ReturnType<typeof createMiddleware<AppEnv>>,
): ReturnType<typeof createMiddleware<AppEnv>> {
  return createMiddleware<AppEnv>((c, next) => (c.get("principal") ? next() : gateway(c, next)));
}
