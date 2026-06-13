import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { UpgradeWebSocket } from "hono/ws";
import type { ModelProvider } from "../ai/provider.js";
import { decideCanvasAccess } from "../canvas/authorization.js";
import { requireCapability } from "../canvas/capability-guard.js";
import type { FilesService } from "../canvas/files-service.js";
import { GATE_COOKIE, verifyGrant } from "../canvas/password-gate.js";
import type { AiUsageRepository } from "../db/repositories/ai-usage.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { KvRepository } from "../db/repositories/kv.js";
import type { UsageEventsRepository } from "../db/repositories/usage-events.js";
import { canvasApiIsolation } from "../http/canvas-api-isolation.js";
import type { AppEnv } from "../http/types.js";
import type { RealtimeHub } from "../realtime/hub.js";
import { canvasAiRoutes } from "./canvas-ai.js";
import { canvasFilesRoutes } from "./canvas-files.js";
import { canvasKvRoutes } from "./canvas-kv.js";
import { canvasRealtimeRoutes } from "./canvas-realtime.js";

export interface CanvasApiDeps {
  config: Config;
  canvases: CanvasesRepository;
  kv: KvRepository;
  files: FilesService;
  usage: UsageEventsRepository;
  aiUsage: AiUsageRepository;
  /** Model provider for the AI primitive (default Anthropic; tests inject a fake). */
  aiProvider: ModelProvider;
  /**
   * Realtime wiring. Present only when a WebSocket adaptor is available (the Node
   * server in index.ts, or a WS integration test). Omitted in plain unit tests —
   * the realtime route is then simply not mounted.
   */
  realtime?: { hub: RealtimeHub; upgradeWebSocket: UpgradeWebSocket };
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

  // AI primitive (M9, area H). Behind requireCapability("ai") inside the router.
  app.route(
    "/ai",
    canvasAiRoutes({ config: deps.config, aiUsage: deps.aiUsage, provider: deps.aiProvider }),
  );

  // Realtime primitive (M9, area R). Mounted only when a WebSocket adaptor is wired
  // (Node server / WS integration test). The handshake inherits the resolve +
  // password-gate + isolation middleware above; capability is checked post-101.
  if (deps.realtime) {
    app.route(
      "/realtime",
      canvasRealtimeRoutes({
        config: deps.config,
        hub: deps.realtime.hub,
        usage: deps.usage,
        upgradeWebSocket: deps.realtime.upgradeWebSocket,
      }),
    );
  }

  return app;
}
