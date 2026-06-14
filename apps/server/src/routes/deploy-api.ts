import { Buffer } from "node:buffer";
import type { Config } from "@canvas-drop/shared";
import type { Canvas, CanvasStatus } from "@canvas-drop/shared/db";
import { publicationState } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AuditLog } from "../audit/audit-log.js";
import { bearerToken, hashApiKey } from "../canvas/api-key.js";
import { canvasUrl } from "../canvas/url.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { DeployEngine } from "../deploy/engine.js";
import { fromZip } from "../deploy/ingest.js";
import { type RateLimitStore, takeToken } from "../http/rate-limit.js";
import type { AppEnv } from "../http/types.js";
import type { RealtimeHub } from "../realtime/hub.js";
import { deployBodyLimit, deployResponse } from "./deploy-common.js";

export interface DeployApiDeps {
  config: Config;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  engine: DeployEngine;
  audit: AuditLog;
  /** Shared rate-limit store (M7). The broad post-gateway middleware never sees
   *  this pre-gateway mount, so the deploy class (§12.3 10/min/canvas) is applied
   *  here, keyed by canvasId resolved after the Bearer key is verified. */
  rateLimitStore?: RateLimitStore;
  /** Realtime hub for drop-sockets on unpublish (D-RT-6). Optional — omitted in
   *  unit tests and when realtime is disabled. */
  hub?: RealtimeHub;
}

/**
 * Programmatic deploy API (§11.4), mounted at `/v1/canvases/:id`. Authenticated
 * by the canvas secret key (`Authorization: Bearer cd_...`), NOT a session — a
 * key operates ONLY on its own canvas. No CORS, no cookies.
 */
export function deployApiRoutes(deps: DeployApiDeps) {
  const app = new Hono<AppEnv>();

  /** Resolve + verify the Bearer key against the :id canvas, or deny. */
  async function authCanvas(c: Context<AppEnv>): Promise<Canvas | { error: 401 | 403 }> {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return { error: 401 };
    const canvas = await deps.canvases.findByApiKeyHash(hashApiKey(token));
    if (!canvas) return { error: 401 };
    if (canvas.id !== c.req.param("id")) return { error: 403 }; // key for a different canvas
    return canvas;
  }

  /** Deploy-class throttle (§12.3 10/min/canvas), keyed by canvasId AFTER the
   *  Bearer key is verified — there is no user on this pre-gateway path. Returns a
   *  429 Response when over the limit, else null. */
  function deployThrottle(c: Context<AppEnv>, canvasId: string): Response | null {
    if (!deps.rateLimitStore || !deps.config.rateLimit.enabled) return null;
    const r = takeToken(
      deps.rateLimitStore,
      `deploy:${canvasId}`,
      deps.config.rateLimit.deployPerMin,
    );
    if (r.allowed) return null;
    c.header("Retry-After", String(r.retryAfterSec));
    return c.json({ error: "rate_limited" }, 429);
  }

  app.put("/:id/deploy", deployBodyLimit, async (c) => {
    const auth = await authCanvas(c);
    if ("error" in auth) return c.json({ error: "unauthorized" }, auth.error);
    const limited = deployThrottle(c, auth.id);
    if (limited) return limited;
    const body = Buffer.from(await c.req.arrayBuffer());
    if (body.byteLength === 0) return c.json({ code: "EMPTY_DEPLOY", message: "empty body" }, 400);
    // Key-authenticated deploy: attribute to the canvas owner (no user session).
    return deployResponse(c, deps.engine, deps.audit, auth, "api", fromZip(body), auth.ownerId);
  });

  app.get("/:id", async (c) => {
    const auth = await authCanvas(c);
    if ("error" in auth) return c.json({ error: "unauthorized" }, auth.error);
    return c.json({
      id: auth.id,
      slug: auth.slug,
      url: canvasUrl(deps.config, auth.slug),
      title: auth.title,
      status: auth.status,
      publicationState: publicationState(
        auth.status as CanvasStatus,
        auth.currentVersionId !== null,
      ),
      currentVersionId: auth.currentVersionId,
    });
  });

  // Unpublish (agent-native parity with the dashboard Unpublish). Takes a published
  // canvas back to Draft: clears the current-version pointer + share/gallery, drops
  // live sockets. 409 CANNOT_UNPUBLISH when the canvas isn't currently published.
  app.post("/:id/unpublish", async (c) => {
    const auth = await authCanvas(c);
    if ("error" in auth) return c.json({ error: "unauthorized" }, auth.error);
    if (!(await deps.canvases.unpublish(auth.id))) {
      return c.json({ code: "CANNOT_UNPUBLISH", message: "This canvas isn't published." }, 409);
    }
    deps.audit.recordAudit({
      action: "canvas_unpublish",
      actorId: auth.ownerId,
      targetId: auth.id,
    });
    if (deps.hub) await deps.hub.revalidateCanvas(auth.id).catch(() => {});
    return c.json({
      url: canvasUrl(deps.config, auth.slug),
      publicationState: "draft" as const,
      currentVersionId: null,
    });
  });

  app.get("/:id/versions", async (c) => {
    const auth = await authCanvas(c);
    if ("error" in auth) return c.json({ error: "unauthorized" }, auth.error);
    const versions = await deps.versions.listByCanvas(auth.id);
    return c.json({
      versions: versions.map((v) => ({
        number: v.number,
        source: v.source,
        status: v.status,
        createdBy: v.createdBy,
        createdAt: v.createdAt,
        fileCount: v.fileCount,
        totalBytes: v.totalBytes,
        current: v.id === auth.currentVersionId,
      })),
    });
  });

  app.post("/:id/rollback", async (c) => {
    const auth = await authCanvas(c);
    if ("error" in auth) return c.json({ error: "unauthorized" }, auth.error);
    const limited = deployThrottle(c, auth.id);
    if (limited) return limited;
    const body = (await c.req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== "number") {
      return c.json({ code: "INVALID_PATH", message: "version (number) required" }, 400);
    }
    const target = await deps.versions.findReadyByNumber(auth.id, body.version);
    if (!target) {
      return c.json({ code: "INVALID_PATH", message: `no ready version ${body.version}` }, 404);
    }
    // Atomic guarded swap (see management rollback) — a concurrent prune may have
    // deleted the target between selection and the swap.
    if (!(await deps.canvases.setCurrentVersionIfReady(auth.id, target.id))) {
      return c.json(
        { code: "VERSION_UNAVAILABLE", message: "that version was just removed; retry" },
        409,
      );
    }
    deps.audit.recordAudit({
      action: "rollback",
      actorId: auth.ownerId,
      targetId: auth.id,
      meta: { version: body.version },
    });
    return c.json({ url: canvasUrl(deps.config, auth.slug), version: body.version });
  });

  return app;
}
