import type { Config } from "@canvas-drop/shared";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { isAnonymouslyReachable } from "../canvas/authorization.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { AppEnv } from "../http/types.js";
import { resolveRequest } from "../routing/resolve-request.js";
import { SESSION_COOKIE } from "./session.js";

export interface PublicCanvasResolverDeps {
  config: Config;
  canvases: Pick<CanvasesRepository, "findBySlug" | "isOwnerPublishEnabled">;
  publicLinksEnabled?: () => Promise<boolean>;
}

/**
 * Pre-gateway carve-out for anonymous `public_link` canvases only. Legacy guest
 * cookies are intentionally ignored; authorization still flows through
 * `decideCanvasAccess`, where public viewers remain static-only.
 *
 * Password-protected public links are INCLUDED (isAnonymouslyReachable, not
 * isAnonymouslyPublic): the carve-out only grants the anonymous principal so the
 * request reaches the password gate (password-gate.ts) instead of being bounced to
 * org sign-in. The gate, decideCanvasAccess (`needsPasswordGate`), and the
 * password-EXCLUSIVE cache/social predicates still keep gated content private.
 */
export function publicCanvasResolver(deps: PublicCanvasResolverDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.get("principal")) return next();

    const { role, canvasSlug } = resolveRequest(
      { host: c.req.header("host") ?? "", pathname: c.req.path },
      deps.config,
    );
    if ((role !== "canvas" && role !== "platform-api") || !canvasSlug) return next();

    const canvas = await deps.canvases.findBySlug(canvasSlug);
    const publicLinksEnabled = await (deps.publicLinksEnabled?.() ?? Promise.resolve(true));
    if (
      canvas &&
      canvas.status === "active" &&
      publicLinksEnabled &&
      (await deps.canvases.isOwnerPublishEnabled(canvas.ownerId)) &&
      isAnonymouslyReachable(canvas.access, canvas.sharedExpiresAt, Date.now())
    ) {
      const anonymous = { kind: "anonymous" as const };
      if (deps.config.auth.mode === "proxy" || getCookie(c, SESSION_COOKIE)) {
        c.set("publicFallbackPrincipal", anonymous);
      } else c.set("principal", anonymous);
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
