import type { Config } from "@canvas-drop/shared";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { AppEnv } from "../http/types.js";
import { resolveRequest } from "../routing/resolve-request.js";
import type { GuestService } from "./guest.js";
import { SESSION_COOKIE } from "./session.js";

export interface GuestPublicResolverDeps {
  config: Config;
  guests: GuestService;
  canvases: CanvasesRepository;
}

/**
 * The pre-gateway carve-out (U7, §12.0). Mounted BEFORE `socialPreview` and the
 * org `authGateway`, and only in app-gated modes (`oidc`/`dev`) — never in
 * `proxy` mode, where the upstream IAP authenticates first (KTD3/KTD7).
 *
 * It derives the role itself via `resolveRequest` (the app's role classifier runs
 * later, after the gateway) and acts only on the two canvas surfaces: `canvas`
 * (static content) and `platform-api` (the `/v1/c/:slug/*` runtime API). For
 * those it establishes a non-org principal when one applies:
 *   - a valid guest session cookie → a guest principal;
 *   - else, a `public_link` canvas with NO org session present → anonymous.
 *
 * Setting a principal signals the gateway (and socialPreview) to step aside — the
 * request proceeds to `decideCanvasAccess`, which is the sole authorization seam
 * (default-deny). The resolver NEVER grants access; it only names the principal.
 * An org member (org session cookie present, or no carve-out applies) falls
 * through to the gateway unchanged.
 */
export function guestPublicResolver(deps: GuestPublicResolverDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const { role, canvasSlug } = resolveRequest(
      { host: c.req.header("host") ?? "", pathname: c.req.path },
      deps.config,
    );
    // Only the canvas surfaces are carved out; everything else uses the org gateway.
    if ((role !== "canvas" && role !== "platform-api") || !canvasSlug) return next();

    // (a) A valid guest magic-link session → guest principal (scoped to its canvas).
    const guest = await deps.guests.resolveGuest(c);
    if (guest) {
      c.set("principal", guest);
      return next();
    }

    // (b) An anonymous visitor (no org session) to a public_link canvas → anonymous.
    //     If an org session cookie IS present, fall through so the gateway
    //     authenticates the member (the owner gets full access; others static-only
    //     via the decision table). The owner capability gate lives in the decision
    //     (publicEnabled, U10).
    if (!getCookie(c, SESSION_COOKIE)) {
      const canvas = await deps.canvases.findBySlug(canvasSlug);
      if (canvas && canvas.status === "active" && canvas.access === "public_link") {
        c.set("principal", { kind: "anonymous" });
        return next();
      }
    }

    // Neither carve-out applies → org gateway path.
    return next();
  });
}

/**
 * Wrap the org `authGateway` so it is skipped once the resolver has established a
 * non-org principal (guest/anonymous). An org member request (no principal) runs
 * the gateway verbatim — its behavior is unchanged.
 */
export function onlyWhenNoPrincipal(
  gateway: ReturnType<typeof createMiddleware<AppEnv>>,
): ReturnType<typeof createMiddleware<AppEnv>> {
  return createMiddleware<AppEnv>((c, next) => (c.get("principal") ? next() : gateway(c, next)));
}
