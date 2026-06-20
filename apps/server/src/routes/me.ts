import type { AuthMode, SkinName } from "@canvas-drop/shared";
import { Hono } from "hono";
import type { OrgsRepository } from "../db/repositories/orgs.js";
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
  /** Resolver for the active design skin — the EFFECTIVE value (admin DB override over
   *  env/default), read per-request so an admin's runtime flip takes effect without a
   *  restart. The SPA applies the result to <html data-skin>. */
  designSkin: () => Promise<SkinName>;
  /** Tenancy org store (plan 002 U6) — resolves the caller's org ids to {id,name}. */
  orgs: Pick<OrgsRepository, "findById">;
  /** Whether tenancy is active (an org is configured). Drives `isGuest`: only meaningful
   *  when active — inert instances have no member/guest boundary. */
  tenancyActive: boolean;
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

  app.get("/", async (c) => {
    const u = c.get("user");
    // The caller's orgs (plan 002 U6): resolve the server-derived orgIds → {id,name} for
    // the Personal/Org workspace switcher. `isGuest` = signed in but in no org (active
    // tenancy only). UX state — the server re-derives orgIds on every request, so a
    // client can never widen its scope by asserting an org.
    const orgIds = c.get("orgIds") ?? new Set<string>();
    const orgRows = (await Promise.all([...orgIds].map((id) => deps.orgs.findById(id)))).filter(
      (o): o is NonNullable<typeof o> => o !== null,
    );
    const orgs = orgRows.map((o) => ({ id: o.id, name: o.name }));
    return c.json({
      id: u.id,
      email: u.email,
      name: u.name,
      avatarUrl: u.avatarUrl,
      isAdmin: u.isAdmin,
      // Tenancy (plan 002 U6) — the member's orgs + whether they're a guest (no org).
      orgs,
      isGuest: deps.tenancyActive && orgIds.size === 0,
      // Whether this account may publish public links (U10) — the dashboard offers
      // the public_link rung only when true.
      canPublishPublic: u.canPublishPublic,
      authMode: deps.authMode,
      // Instance URL config (plan 004) — UX-only, like authMode; NEVER an authz signal.
      // The dashboard uses these to preview a custom slug's final URL before create.
      urlMode: deps.urlMode,
      baseUrl: deps.baseUrl,
      // Active design skin (presentation only) — the EFFECTIVE value (admin override
      // over env/default), resolved per-request. The SPA applies it to <html data-skin>.
      designSkin: await deps.designSkin(),
    });
  });

  return app;
}
