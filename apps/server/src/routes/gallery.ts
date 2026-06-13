import type { Config } from "@canvas-drop/shared";
import { Hono } from "hono";
import { z } from "zod";
import { canvasUrl } from "../canvas/url.js";
import type { CanvasesRepository, GalleryRow } from "../db/repositories/canvases.js";
import type { AppEnv } from "../http/types.js";

export interface GalleryDeps {
  config: Config;
  canvases: CanvasesRepository;
}

const MAX_LIMIT = 60;
const DEFAULT_LIMIT = 24;

/**
 * Browse-query schema. A gallery URL with a junk param should still render the
 * page, so invalid/absent values clamp to sane defaults rather than 400ing:
 * `limit` coerces + clamps to [1, 60] (default 24), `offset` clamps to >= 0
 * (default 0). `q` / `tag` are optional free text.
 */
const querySchema = z.object({
  q: z.string().trim().min(1).optional(),
  tag: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().catch(DEFAULT_LIMIT),
  offset: z.coerce.number().int().catch(0),
});

/** Display-only projection of a gallery row — explicit field list, never a spread
 *  of the canvas/user row, so api_key_hash / password_hash / owner email / internal
 *  flags can never leak (§12.0 #1). */
function galleryItem(config: Config, row: GalleryRow) {
  const cv = row.canvas;
  return {
    id: cv.id,
    slug: cv.slug,
    url: canvasUrl(config, cv.slug),
    title: cv.title,
    summary: cv.gallerySummary,
    tags: (cv.galleryTags as string[] | null) ?? [],
    hasPassword: cv.passwordHash !== null,
    publishedAt: cv.galleryPublishedAt,
    owner: { name: row.ownerName, avatarUrl: row.ownerAvatarUrl },
  };
}

/**
 * Opt-in gallery browse API (§6.9 #11, plan 008 / M8), mounted at `/api/gallery`.
 * Behind the session gateway (login on every request) — so the visibility
 * predicate runs for an authenticated member with no cached grants. GET-only, so
 * no same-origin guard (that guards mutations). Its own router, NOT under
 * `/api/canvases`, whose `/:id` would shadow a literal `gallery` segment.
 */
export function galleryRoutes(deps: GalleryDeps) {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    // safeParse only fails on a non-coercible shape; fall back to all-defaults so a
    // browse never errors on a malformed query string.
    const params = parsed.success ? parsed.data : { limit: DEFAULT_LIMIT, offset: 0 };
    const limit = Math.min(Math.max(params.limit, 1), MAX_LIMIT);
    const offset = Math.max(params.offset, 0);

    const { items, total } = await deps.canvases.listGallery({
      now: Date.now(),
      q: "q" in params ? params.q : undefined,
      tag: "tag" in params ? params.tag : undefined,
      limit,
      offset,
    });

    return c.json({
      items: items.map((row) => galleryItem(deps.config, row)),
      total,
      limit,
      offset,
    });
  });

  return app;
}
