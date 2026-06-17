import type { Config } from "@canvas-drop/shared";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../http/types.js";
import { resolveRequest } from "../routing/resolve-request.js";
import { CAPTURE_TOKEN_HEADER, verifyCaptureToken } from "./capture-token.js";

export interface CaptureResolverDeps {
  config: Config;
  /** The session secret the worker signs capture tokens with (server-side only). */
  secret: string;
}

/**
 * Internal capture carve-out (plan 004 / U5, §12.0). The companion to
 * `guestPublicResolver`: a pre-gateway resolver that establishes the `capture`
 * principal for the screenshot worker's own requests, then lets `decideCanvasAccess`
 * (U3) decide — it NEVER grants access itself.
 *
 * Identity comes only from a **server-minted, HMAC-verified** capture token carried in
 * an internal header (§12.0 #1) — a client cannot forge one without the session secret,
 * so this is safe to mount in EVERY auth mode (unlike the guest carve-out, which is
 * oidc/dev only because guest cookies are app-gated). In `proxy` mode it is how the
 * in-process worker's loopback request gets past the IAP-header gateway.
 *
 * Like the guest resolver: derives its own role (the classifier runs later), acts only
 * on `canvas`/`platform-api` surfaces, and no-ops when no valid token is present (the
 * request then follows the normal guest/anonymous/org path). The token's canvas scope is
 * enforced downstream by `decideCanvasAccess` (a token for canvas A renders only A).
 */
export function captureResolver(deps: CaptureResolverDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.get("principal")) return next(); // a principal is already set — don't override
    const token = c.req.header(CAPTURE_TOKEN_HEADER);
    if (!token) return next(); // overwhelmingly the common case — cheap bail

    const { role, canvasSlug } = resolveRequest(
      { host: c.req.header("host") ?? "", pathname: c.req.path },
      deps.config,
    );
    // ONLY the canvas content surface — never `platform-api` (the runtime primitive
    // API). The worker captures static canvas content; a captured canvas's JS hitting
    // `/v1/...` must not be granted an owner-equivalent capture principal (review #4/#5).
    // The capture engine also blocks `/v1/` during render; this is the matching gate.
    if (role !== "canvas" || !canvasSlug) return next();

    const claims = verifyCaptureToken(deps.secret, token);
    if (claims) {
      c.set("principal", {
        kind: "capture",
        canvasId: claims.canvasId,
        versionId: claims.versionId,
      });
    }
    return next();
  });
}
