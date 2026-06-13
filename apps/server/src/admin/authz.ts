import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../http/types.js";

/**
 * Admin gate (§6.10, M7). `isAdmin` is resolved server-side by the auth gateway
 * from `CANVAS_DROP_ADMIN_EMAILS` at user upsert (identity-mapping.ts) — it is
 * NEVER client-asserted (§12.0 #1). Applied to the whole `/api/admin/*` router.
 *
 * Returns **404** (not 403) for a non-admin, matching the `ownedCanvas`
 * existence-non-confirmation posture (§12.1.4): the admin surface should not even
 * confirm it exists to a non-admin. Must run AFTER the gateway has set `c.get("user")`.
 */
export function requireAdmin() {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!c.get("user")?.isAdmin) {
      return c.json({ error: "not_found" }, 404);
    }
    await next();
  });
}
