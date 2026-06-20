import type { AuthMode, SkinName } from "@canvas-drop/shared";
import { Hono } from "hono";
import type { AppEnv } from "../http/types.js";

/** Auth mode the instance runs in (§8.1). The SPA reads this to decide whether to
 * offer in-app sign-out: `oidc`/`dev` own a revocable session (`/auth/logout`),
 * while in `proxy` mode the trusted proxy owns identity and the app has no session
 * to revoke. UX only — never an authz signal. The union is owned by
 * `@canvas-drop/shared` (derived from the config enum) — re-exported here for
 * call sites that already import from this route module. */
export type MeAuthMode = AuthMode;

export interface MeRoutesDeps {
  authMode: AuthMode;
  /** Instance URL shape (plan 004) — lets the dashboard render a faithful slug URL preview. */
  urlMode: "path" | "subdomain";
  baseUrl: string;
  /** Active instance-wide design skin (expression layer) — the SPA sets it on <html>. */
  designSkin: SkinName;
}

/**
 * Current-user identity for the dashboard SPA (§6.8.1 / §11.3), mounted at
 * `/api/me`. Behind the session gateway, so `c.get("user")` is always the
 * resolved server-side identity (§12.0 invariant #1 — never client-asserted).
 *
 * Mounted as its OWN router, NOT under `/api/canvases`: that router's `/:id`
 * route would otherwise match `me` as a canvas id and 404.
 *
 * Returns an EXPLICIT field projection — never a spread of the user row — so a
 * future internal column can never leak to the browser. `authMode` is instance
 * config (not user data) and is safe to expose: it only tells the client which
 * shell affordances apply (e.g. whether to show in-app sign-out).
 */
export function meRoutes(deps: MeRoutesDeps) {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const u = c.get("user");
    return c.json({
      id: u.id,
      email: u.email,
      name: u.name,
      avatarUrl: u.avatarUrl,
      isAdmin: u.isAdmin,
      // Whether this account may publish public links (U10) — the dashboard offers
      // the public_link rung only when true.
      canPublishPublic: u.canPublishPublic,
      authMode: deps.authMode,
      // Instance URL config (plan 004) — UX-only, like authMode; NEVER an authz signal.
      // The dashboard uses these to preview a custom slug's final URL before create.
      urlMode: deps.urlMode,
      baseUrl: deps.baseUrl,
      // Active design skin (presentation only) — the SPA applies it to <html data-skin>.
      designSkin: deps.designSkin,
    });
  });

  return app;
}
