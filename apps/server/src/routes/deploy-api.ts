import { Buffer } from "node:buffer";
import type { Config } from "@canvas-drop/shared";
import type { Canvas, CanvasStatus } from "@canvas-drop/shared/db";
import { publicationState } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AuditLog } from "../audit/audit-log.js";
import { bearerToken, hashApiKey } from "../canvas/api-key.js";
import { liveManifest } from "../canvas/manifest.js";
import { blobKey } from "../canvas/storage-keys.js";
import { canvasUrl } from "../canvas/url.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { DeployEngine } from "../deploy/engine.js";
import { DeployError } from "../deploy/errors.js";
import { fromZip } from "../deploy/ingest.js";
import { type RateLimitStore, takeToken } from "../http/rate-limit.js";
import type { AppEnv } from "../http/types.js";
import type { RealtimeHub } from "../realtime/hub.js";
import type { StorageDriver } from "../storage/driver.js";
import type { UploadService } from "../upload/service.js";
import {
  blobBodyLimit,
  deployBodyLimit,
  deployErrorResponse,
  deployResponse,
} from "./deploy-common.js";

export interface DeployApiDeps {
  config: Config;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  engine: DeployEngine;
  audit: AuditLog;
  /** Blob store — read-only here, backs the `GET …/files` deploy read-back. */
  storage: StorageDriver;
  /** Shared rate-limit store (M7). The broad post-gateway middleware never sees
   *  this pre-gateway mount, so the deploy class (§12.3 10/min/canvas) is applied
   *  here, keyed by canvasId resolved after the Bearer key is verified. */
  rateLimitStore?: RateLimitStore;
  /** Realtime hub for drop-sockets on unpublish (D-RT-6). Optional — omitted in
   *  unit tests and when realtime is disabled. */
  hub?: RealtimeHub;
  /** Two-channel staging upload service (plan 003). Optional — when absent the
   *  `/uploads` routes are not registered. */
  upload?: UploadService;
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

  // --- Two-channel staging upload (plan 003) -----------------------------------
  // begin → PUT each missing blob directly (bytes never touch an agent's context)
  // → finalize. Same UploadService the MCP tools use; key auth + the deploy
  // throttle gate it. Registered only when the upload service is wired.
  const upload = deps.upload;
  if (upload) {
    // Open a session: body { manifest: [{ path, hash, size }] }. Returns the
    // uploadId + the subset of hashes not already stored for this canvas.
    app.post("/:id/uploads", async (c) => {
      const auth = await authCanvas(c);
      if ("error" in auth) return c.json({ error: "unauthorized" }, auth.error);
      const limited = deployThrottle(c, auth.id);
      if (limited) return limited;
      let body: { manifest?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ code: "INVALID_MANIFEST", message: "body must be JSON" }, 400);
      }
      const manifest = (body as { manifest?: unknown }).manifest;
      if (!Array.isArray(manifest)) {
        return c.json({ code: "INVALID_MANIFEST", message: "manifest must be an array" }, 400);
      }
      try {
        const result = await upload.begin(auth, auth.ownerId, manifest);
        return c.json(result);
      } catch (err) {
        if (err instanceof DeployError) return deployErrorResponse(c, err);
        throw err;
      }
    });

    // Stage one blob (raw body). The handle is bound to :id — a handle minted for
    // another canvas is rejected as UPLOAD_HANDLE_INVALID (404, no existence leak).
    app.put("/:id/uploads/:uploadId/blobs/:hash", blobBodyLimit, async (c) => {
      const auth = await authCanvas(c);
      if ("error" in auth) return c.json({ error: "unauthorized" }, auth.error);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      try {
        await upload.stageBlob(
          c.req.param("uploadId"),
          auth.ownerId,
          auth.id,
          c.req.param("hash"),
          bytes,
        );
        return c.body(null, 204);
      } catch (err) {
        if (err instanceof DeployError) return deployErrorResponse(c, err);
        throw err;
      }
    });

    // Finalize: publish a new version from the staged manifest.
    app.post("/:id/uploads/:uploadId/finalize", async (c) => {
      const auth = await authCanvas(c);
      if ("error" in auth) return c.json({ error: "unauthorized" }, auth.error);
      const limited = deployThrottle(c, auth.id);
      if (limited) return limited;
      try {
        const result = await upload.finalize(c.req.param("uploadId"), auth.ownerId, auth.id);
        deps.audit.recordAudit({
          action: "deploy",
          actorId: auth.ownerId,
          targetId: auth.id,
          meta: { source: "upload", version: result.version, fileCount: result.fileCount },
        });
        return c.json(result);
      } catch (err) {
        if (err instanceof DeployError) return deployErrorResponse(c, err);
        throw err;
      }
    });
  }

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

  // Read back what is LIVE — the curl path's deploy-verification surface, mirroring
  // the MCP `get_canvas_file` tool. The served canvas URL is access-controlled (a
  // keyed agent can't fetch it), so this is how a curl agent confirms what shipped.
  //   GET …/files              → JSON listing { version, fileCount, files[] }
  //   GET …/files?path=foo.js  → that file's RAW bytes (curl | sha256sum to verify)
  // No size cap: the caller streams the body and decides what to do with it.
  app.get("/:id/files", async (c) => {
    const auth = await authCanvas(c);
    if ("error" in auth) return c.json({ error: "unauthorized" }, auth.error);
    const live = await liveManifest(deps.versions, auth.currentVersionId);
    if (!live) return c.json({ code: "NOT_PUBLISHED", message: "no live version" }, 404);
    const path = c.req.query("path");
    if (path == null) {
      const paths = Object.keys(live.manifest).sort();
      return c.json({
        version: live.number,
        fileCount: paths.length,
        files: paths.map((p) => {
          const e = live.manifest[p] as (typeof live.manifest)[string];
          return { path: p, size: e.size, mime: e.mime, hash: e.hash };
        }),
      });
    }
    const entry = live.manifest[path];
    if (!entry) return c.json({ code: "NOT_FOUND", message: `no file at "${path}"` }, 404);
    const bytes = await deps.storage.get(blobKey(auth.id, entry.hash));
    if (!bytes) return c.json({ code: "NOT_FOUND", message: "file blob missing" }, 404);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": entry.mime,
        ETag: `"${entry.hash}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
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
