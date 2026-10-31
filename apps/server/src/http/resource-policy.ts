import type { Config } from "@canvas-drop/shared";
import { isRestrictedRung } from "@canvas-drop/shared/db";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./types.js";

/**
 * Restricted canvases refuse to be embedded by other canvases (audit run-1, #24).
 *
 * In subdomain mode every canvas is same-site with every other, so the visitor's
 * SameSite=Lax session cookie rides on an `<img>`, `<script>` or `<link>` one canvas
 * points at another. Whether that load succeeds told the embedding canvas whether its
 * visitor can open the other one. `Cross-Origin-Resource-Policy: same-origin` makes the
 * browser refuse the bytes to any other origin, so a restricted canvas's responses read
 * the same as its denials. Whole-org and public-link canvases are left alone: anyone the
 * embedding canvas could ask about may open them anyway, and org canvases legitimately
 * share assets. The dashboard's own cover requests use CORS (see `servePreview`).
 *
 * In path mode every canvas shares one origin, so the header would change nothing.
 */
export function restrictedResourcePolicy(config: Config) {
  return createMiddleware<AppEnv>(async (c, next) => {
    await next();
    if (config.urlMode !== "subdomain") return;
    const canvas = c.get("canvas");
    if (!canvas || !isRestrictedRung(canvas.access)) return;
    try {
      c.res.headers.set("Cross-Origin-Resource-Policy", "same-origin");
    } catch {
      // An immutable Response (none are built on this path today): copy it.
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set("Cross-Origin-Resource-Policy", "same-origin");
    }
  });
}
