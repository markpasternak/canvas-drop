import type { Config } from "@canvas-drop/shared";
import type { Canvas, Draft, Manifest } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { resolveAsset } from "../canvas/asset-resolver.js";
import { manifestsEqual } from "../canvas/manifest.js";
import { mimeFor } from "../canvas/mime.js";
import { requireOwnedCanvas } from "../canvas/owner-guard.js";
import { blobKey } from "../canvas/storage-keys.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import { DeployError } from "../deploy/errors.js";
import { injectOnPageEditor } from "../draft/onpage.js";
import type { DraftService } from "../draft/service.js";
import { requireSameOrigin } from "../http/same-origin.js";
import type { AppEnv } from "../http/types.js";
import type { StorageDriver } from "../storage/driver.js";

export interface DraftApiDeps {
  config: Config;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  drafts: DraftService;
  storage: StorageDriver;
}

/** Serialize a draft for the editor: file list + state, never raw blob bytes. */
function draftView(draft: Draft, liveManifest: Manifest | null) {
  const manifest = draft.manifest as Manifest;
  const files = Object.entries(manifest)
    .map(([path, e]) => ({ path, size: e.size, mime: e.mime }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    stale: draft.stale,
    baseVersionId: draft.baseVersionId,
    updatedAt: draft.updatedAt,
    // Unpublished changes = the draft differs from the live version (or there is none).
    dirty: isDirty(manifest, liveManifest),
  };
}

/** Whether the draft manifest diverges from the live version's (path set or any hash). */
function isDirty(draft: Manifest, live: Manifest | null): boolean {
  if (!live) return Object.keys(draft).length > 0;
  return !manifestsEqual(draft, live);
}

function previewNotFound(c: Context<AppEnv>): Response {
  return c.body(JSON.stringify({ error: "not_found" }), 404, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
}

function deployErr(c: Context<AppEnv>, err: unknown): Response | never {
  if (err instanceof DeployError) {
    return c.json({ code: err.code, message: err.message, path: err.path }, 400);
  }
  throw err;
}

/**
 * In-browser editor API (M5, R11–R15) — owner-only, same-origin, mounted at
 * `/api/canvases`. Mutates the canvas's draft (no version) and explicitly
 * publishes/restores. Sits alongside `managementRoutes` at the same base; its
 * paths (`/:id/draft*`, `/:id/publish`, `/:id/restore`, `/:id/preview/*`) don't
 * collide with the lifecycle routes.
 */
export function draftApiRoutes(deps: DraftApiDeps) {
  const app = new Hono<AppEnv>();
  const sameOrigin = requireSameOrigin(deps.config);

  // Owner-only gate (shared with management.ts) — a non-owner admin gets 404 here too,
  // since the editor/draft/preview surface exposes canvas content.
  const ownedCanvas = (c: Context<AppEnv>) => requireOwnedCanvas(c, deps.canvases);

  async function liveManifest(cv: Canvas): Promise<Manifest | null> {
    if (!cv.currentVersionId) return null;
    const v = await deps.versions.findById(cv.currentVersionId);
    return v?.status === "ready" && v.manifest ? (v.manifest as Manifest) : null;
  }

  async function viewOf(c: Context<AppEnv>, cv: Canvas, draft: Draft): Promise<Response> {
    return c.json(draftView(draft, await liveManifest(cv)));
  }

  // Draft state + file list (creates the draft from the live version on first open, R10).
  app.get("/:id/draft", async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const draft = await deps.drafts.getOrCreate(cv);
    return viewOf(c, cv, draft);
  });

  // Raw draft-file bytes for the editor to load (owner-only, never cached).
  app.get("/:id/draft/file", async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const path = c.req.query("path");
    if (!path) return c.json({ code: "INVALID_PATH", message: "path required" }, 400);
    const bytes = await deps.drafts.readFile(cv, path);
    if (!bytes) return c.json({ error: "not_found" }, 404);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": mimeFor(path).contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  // Write/replace a draft file (raw body bytes — works for text and binary).
  app.put("/:id/draft/file", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const path = c.req.query("path");
    if (!path) return c.json({ code: "INVALID_PATH", message: "path required" }, 400);
    // Optimistic-concurrency (opt-in): a best-effort writer — the editor's unmount flush —
    // pins the draft fork-point it edited against via `If-Draft-Base`. If a restore (or any
    // wholesale replace) has since moved `baseVersionId`, reject so a stale single-file write
    // can't clobber the new draft. `null` base is encoded as the `none` sentinel client-side.
    // Header absent = no precondition (normal autosave/upload/create are unaffected).
    const expectedBase = c.req.header("If-Draft-Base");
    if (expectedBase !== undefined) {
      const current = await deps.drafts.getOrCreate(cv);
      if ((current.baseVersionId ?? "none") !== expectedBase) {
        return c.json(
          {
            code: "DRAFT_CONFLICT",
            message: "The draft changed since this edit; not overwriting.",
          },
          409,
        );
      }
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    // `?mode=create` = "Add a file": refuse to overwrite an existing path (R11) so a
    // create can never silently truncate the file already there. A plain PUT (autosave,
    // replace, upload) stays an upsert.
    const mustNotExist = c.req.query("mode") === "create";
    try {
      const draft = await deps.drafts.writeFile(cv, path, bytes, { mustNotExist });
      return viewOf(c, cv, draft);
    } catch (err) {
      return deployErr(c, err);
    }
  });

  app.delete("/:id/draft/file", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const path = c.req.query("path");
    if (!path) return c.json({ code: "INVALID_PATH", message: "path required" }, 400);
    try {
      const draft = await deps.drafts.deleteFile(cv, path);
      return viewOf(c, cv, draft);
    } catch (err) {
      return deployErr(c, err);
    }
  });

  app.post("/:id/draft/rename", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const body = z
      .object({ from: z.string().min(1), to: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    try {
      const draft = await deps.drafts.renameFile(cv, body.data.from, body.data.to);
      return viewOf(c, cv, draft);
    } catch (err) {
      return deployErr(c, err);
    }
  });

  // Publish the draft as a new immutable version + swap the live pointer (R12).
  app.post("/:id/publish", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    if (cv.status !== "active") {
      return c.json(
        { code: "NOT_ACTIVE", message: "Unarchive this canvas before publishing." },
        409,
      );
    }
    try {
      const result = await deps.drafts.publish(cv, c.get("user").id);
      return c.json(result);
    } catch (err) {
      return deployErr(c, err);
    }
  });

  // Owner-only draft preview (R13/KTD-6). Streams the draft's files from the
  // dashboard origin so the public canvas origin only ever serves published
  // versions. Never cached (the draft is mutable). The `*` wildcard carries the
  // asset path after `/preview`.
  const servePreview = async (c: Context<AppEnv>): Promise<Response> => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    try {
      const draft = await deps.drafts.getOrCreate(cv);
      const manifest = draft.manifest as Manifest;
      // Derive the asset sub-path from the URL (Hono doesn't populate param("*") for
      // a trailing wildcard) by stripping the `/api/canvases/:id/preview` prefix.
      const prefix = `/api/canvases/${c.req.param("id")}/preview`;
      const assetPath = (
        c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : ""
      ).replace(/^\/+/, "");
      const resolved = resolveAsset(manifest, assetPath, cv.spaFallback);
      if (!resolved) return previewNotFound(c);

      const entry = manifest[resolved.path];
      if (!entry) return previewNotFound(c);
      const bytes = await deps.storage.get(blobKey(cv.id, entry.hash));
      if (!bytes) return previewNotFound(c);

      const contentType = mimeFor(resolved.path).contentType;
      // On-page editing (?edit=1): inject the editing shim into the entry HTML only.
      // Sub-resources (css/img) are served untouched so the rendered page is faithful.
      let out: Uint8Array = new Uint8Array(bytes);
      if (c.req.query("edit") === "1" && contentType.startsWith("text/html")) {
        out = new TextEncoder().encode(injectOnPageEditor(new TextDecoder().decode(bytes)));
      }
      return new Response(out, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "same-origin",
          "Content-Security-Policy": "frame-ancestors 'self'",
        },
      });
    } catch {
      // A storage/DB hiccup shouldn't surface a raw 500 with a stack trace — mirror
      // the sibling handlers and return the stable not-found shape.
      return previewNotFound(c);
    }
  };
  app.get("/:id/preview", servePreview);
  app.get("/:id/preview/*", servePreview);

  // Restore a published version into the draft (R14).
  app.post("/:id/restore", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const body = z
      .object({ version: z.number().int().positive() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ code: "INVALID_PATH", message: "version required" }, 400);
    try {
      const draft = await deps.drafts.restore(cv, body.data.version);
      return viewOf(c, cv, draft);
    } catch (err) {
      return deployErr(c, err);
    }
  });

  return app;
}
