import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { QuotaResolver } from "../admin/settings-service.js";
import type { AuditLog } from "../audit/audit-log.js";
import { decideCanvasAccess } from "../canvas/authorization.js";
import { requireCapability } from "../canvas/capability-guard.js";
import type { FilesService } from "../canvas/files-service.js";
import { GATE_COOKIE, verifyGrant } from "../canvas/password-gate.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { KvRepository } from "../db/repositories/kv.js";
import type { UsageEventsRepository } from "../db/repositories/usage-events.js";
import { canvasApiIsolation } from "../http/canvas-api-isolation.js";
import type { AppEnv } from "../http/types.js";
import { canvasFilesRoutes } from "./canvas-files.js";
import { canvasKvRoutes } from "./canvas-kv.js";

export interface CanvasApiDeps {
  config: Config;
  canvases: CanvasesRepository;
  kv: KvRepository;
  files: FilesService;
  usage: UsageEventsRepository;
  /** Audit sink (M7) — KV/file MUTATIONS are recorded for the §12.1.8 security trail. */
  audit: AuditLog;
  /** Admin-tunable quota resolver (M7) — threaded to the KV route's key-limit check. */
  quota?: QuotaResolver;
}

/**
 * Canvas-facing runtime API (§11.4, plan 007 / M6), mounted at `/v1/c/:slug`.
 * Runs after the auth gateway (login enforced, §12.0 #1). Pipeline: resolve +
 * authorize the canvas from the path slug → cross-canvas isolation + CORS
 * (§12.0 #4) → per-route `requireCapability` (plan 006). The primitives (me/kv/
 * files) are thin handlers behind this seam; AI + realtime arrive in M9.
 */
export function canvasApiRoutes(deps: CanvasApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Resolve + authorize the canvas from the path slug into c.get("canvas").
  app.use(
    "*",
    createMiddleware<AppEnv>(async (c, next) => {
      const slug = c.req.param("slug");
      if (!slug) return c.json({ code: "NOT_FOUND" }, 404);
      const canvas = await deps.canvases.findBySlug(slug);
      const decision = decideCanvasAccess(canvas, c.get("user"), Date.now());
      if (decision.action === "deny") {
        return c.json({ code: decision.reason.toUpperCase() }, decision.status);
      }
      // Password gate: a shared, password-protected canvas's API stays closed
      // until the viewer has satisfied the gate (same lock as the content path —
      // §12.0 #3). Owners/admins bypass it (needsPasswordGate is false for them).
      if (
        decision.needsPasswordGate &&
        !verifyGrant(deps.config.sessionSecret, canvas as Canvas, getCookie(c, GATE_COOKIE))
      ) {
        return c.json({ code: "PASSWORD_REQUIRED" }, 403);
      }
      c.set("canvas", canvas as Canvas);
      await next();
    }),
  );

  // Cross-canvas isolation + credentialed CORS (§12.0 #4, §9.4).
  app.use("*", canvasApiIsolation(deps.config));

  // Identity primitive (U5): minimal projection (NO isAdmin), identity-capability
  // gated (→ 403 when backend is off). Explicit fields, never a row spread.
  app.get("/me", requireCapability("identity", deps.config), (c) => {
    const u = c.get("user");
    return c.json({ id: u.id, email: u.email, name: u.name, avatarUrl: u.avatarUrl });
  });

  // KV primitive (U6) and Files primitive (U7).
  app.route("/kv", canvasKvRoutes(deps));
  app.route("/files", canvasFilesRoutes(deps));

  return app;
}
