import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { createMiddleware } from "hono/factory";
import { assetPathFor } from "../canvas/asset-resolver.js";
import {
  SCREENSHOT_RENDITIONS,
  type ScreenshotRendition,
  screenshotKey,
} from "../canvas/storage-keys.js";
import type { AppEnv } from "../http/types.js";
import type { StorageDriver } from "../storage/driver.js";

/**
 * Access-gated preview serving (plan 004 / U7, R5). A reserved path on the canvas
 * content surface, mounted AFTER `canvasAccess` + `passwordGate` — so the access
 * decision (`decideCanvasAccess`) and the password rung have already run. By the time
 * this handler sees a request, the requester is authorized to view the canvas:
 *   - owner / allowed member / invited guest → served (incl. private/gated covers);
 *   - public_link anonymous → served (the cover is public, like the content);
 *   - anyone else → `canvasAccess` already 404'd, never reaching here.
 *
 * So a **private canvas's preview is never fetchable by an unauthorized requester**
 * (R5) — the same gate as the canvas content itself, no separate access logic.
 *
 * Reads the canvas-stable key (KTD-6 — one preview per canvas, overwritten). When the
 * feature is effective-disabled OR no preview exists yet, returns a clean 404 so the
 * client falls back to `GenerativeCover` (standard mode behaves exactly like today).
 * The cover URL is cache-busted by the caller (`?v=<versionId>`); the key is stable so
 * the response is cacheable-but-revalidating.
 */
export const PREVIEW_ASSET_PATH = "__canvasdrop_preview";

// `card`/`thumb` are served to authenticated sessions on possibly-private canvases →
// always `private`. The `og` rendition MAY be shared-cached (CDN), but only for a
// public_link canvas — the public directive must be gated on the canvas's actual
// access rung, not the rendition alone (review server-canvas-8): an authorized member
// requesting ?rendition=og on a whole_org/private canvas would otherwise hand an
// intermediary cache a `public` screenshot of non-public content. The URL is
// version-cache-busted, so a public_link og is safe to shared-cache.
const cacheControl = (rendition: ScreenshotRendition, canvas: Canvas): string => {
  const shareable = rendition === "og" && canvas.access === "public_link";
  return `${shareable ? "public" : "private"}, max-age=300, must-revalidate`;
};

function parseRendition(raw: string | undefined): ScreenshotRendition {
  return (SCREENSHOT_RENDITIONS as readonly string[]).includes(raw ?? "")
    ? (raw as ScreenshotRendition)
    : "card";
}

export interface ServePreviewDeps {
  config: Config;
  storage: Pick<StorageDriver, "get">;
  /** Effective enablement (env-available AND admin-enabled). */
  enabled: () => Promise<boolean>;
}

export function servePreview(deps: ServePreviewDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const canvas = c.get("canvas") as Canvas | undefined;
    if (!canvas) return next();
    // Only the reserved preview path; everything else is real canvas content.
    if (assetPathFor(deps.config, canvas.slug, c.req.path) !== PREVIEW_ASSET_PATH) return next();

    // Per-canvas preview policy:
    //  - `off`    → no preview; 404 so the client shows GenerativeCover.
    //  - `custom` → owner-uploaded; serve it regardless of the global pipeline switch
    //               (a custom upload doesn't depend on the auto-capture pipeline).
    //  - `auto`   → only when the pipeline is effective-enabled (env-available + admin).
    if (canvas.previewMode === "off") return c.notFound();
    if (canvas.previewMode !== "custom" && !(await deps.enabled())) return c.notFound();

    const rendition = parseRendition(c.req.query("rendition"));
    const bytes = await deps.storage.get(screenshotKey(canvas.id, rendition));
    if (!bytes) return c.notFound(); // not captured yet → placeholder on the client

    // Copy into a fresh Uint8Array so the body is a plain ArrayBuffer view (mirrors
    // serveCanvas).
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "Content-Type": "image/webp", "Cache-Control": cacheControl(rendition, canvas) },
    });
  });
}
