import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { UpgradeWebSocket } from "hono/ws";
import type { QuotaResolver } from "../admin/settings-service.js";
import type { ModelProvider } from "../ai/provider.js";
import type { AuditLog } from "../audit/audit-log.js";
import {
  decideCanvasAccess,
  requestPrincipal,
  resolveAccessContext,
} from "../canvas/authorization.js";
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
import { type AiSettings, canvasAiRoutes } from "./canvas-ai.js";
import { canvasFilesRoutes } from "./canvas-files.js";
import { canvasKvRoutes } from "./canvas-kv.js";
import { canvasRealtimeRoutes } from "./canvas-realtime.js";

export interface CanvasApiDeps {
  config: Config;
  canvases: CanvasesRepository;
  kv: KvRepository;
  files: FilesService;
  usage: UsageEventsRepository;
  /** Audit sink (M7) — KV/file MUTATIONS are recorded for the §12.1.8 security
   *  trail. Optional so an AI/realtime-only suite needn't wire it; app.ts always
   *  provides it in production. */
  audit?: AuditLog;
  /** Admin-tunable quota resolver (M7) — threaded to the KV route's key-limit check. */
  quota?: QuotaResolver;
  aiUsage: AiUsageRepository;
  /** Ready provider for the AI primitive — tests inject a fake. */
  aiProvider?: ModelProvider;
  /** Production: builds the provider from the effective key (DB override ?? env). */
  makeAiProvider?: (apiKey: string) => ModelProvider;
  /** Unified settings (effective model allowlist + provider key); omitted in unit tests. */
  settings?: AiSettings;
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
      const principal = requestPrincipal(c);
      const ctx = await resolveAccessContext(deps.canvases, canvas, principal);
      const decision = decideCanvasAccess(canvas, principal, Date.now(), ctx);
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
      // staticOnly (public_link, U3): the runtime API is unavailable to a
      // static-only principal — every primitive is refused (R17). Guest-vs-anonymous
      // primitive policy lands in U9; here we close the API for the static tier.
      c.set("staticOnly", decision.staticOnly);
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
    canvasAiRoutes({
      config: deps.config,
      aiUsage: deps.aiUsage,
      provider: deps.aiProvider,
      makeProvider: deps.makeAiProvider,
      settings: deps.settings,
    }),
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
