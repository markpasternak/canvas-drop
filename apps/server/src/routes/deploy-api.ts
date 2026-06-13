import { Buffer } from "node:buffer";
import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AuditLog } from "../audit/audit-log.js";
import { bearerToken, hashApiKey } from "../canvas/api-key.js";
import { canvasUrl } from "../canvas/url.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { DeployEngine } from "../deploy/engine.js";
import { fromZip } from "../deploy/ingest.js";
import type { AppEnv } from "../http/types.js";
import { deployResponse } from "./deploy-common.js";

export interface DeployApiDeps {
  config: Config;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  engine: DeployEngine;
  audit: AuditLog;
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

  app.put("/:id/deploy", async (c) => {
    const auth = await authCanvas(c);
    if ("error" in auth) return c.json({ error: "unauthorized" }, auth.error);
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
      currentVersionId: auth.currentVersionId,
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
    const body = (await c.req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== "number") {
      return c.json({ code: "INVALID_PATH", message: "version (number) required" }, 400);
    }
    const target = await deps.versions.findReadyByNumber(auth.id, body.version);
    if (!target) {
      return c.json({ code: "INVALID_PATH", message: `no ready version ${body.version}` }, 404);
    }
    await deps.canvases.setCurrentVersion(auth.id, target.id);
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
