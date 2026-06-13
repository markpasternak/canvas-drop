import { Hono } from "hono";
import type { AppEnv } from "../http/types.js";

/**
 * Current-user identity for the dashboard SPA (§6.8.1 / §11.3), mounted at
 * `/api/me`. Behind the session gateway, so `c.get("user")` is always the
 * resolved server-side identity (§12.0 invariant #1 — never client-asserted).
 *
 * Mounted as its OWN router, NOT under `/api/canvases`: that router's `/:id`
 * route would otherwise match `me` as a canvas id and 404.
 *
 * Returns an EXPLICIT five-field projection — never a spread of the user row —
 * so a future internal column can never leak to the browser.
 */
export function meRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const u = c.get("user");
    return c.json({
      id: u.id,
      email: u.email,
      name: u.name,
      avatarUrl: u.avatarUrl,
      isAdmin: u.isAdmin,
    });
  });

  return app;
}
