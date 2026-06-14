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
  // Owner filter is an opaque user id (plan 004). Templatable coerces the string
  // query value to a boolean ("1"/"true" → true). Sort falls back to the default
  // axis on any unknown value, so a junk `sort` never 400s the browse.
  owner: z.string().trim().min(1).optional(),
  templatable: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  sort: z.enum(["published", "updated", "title"]).catch("published"),
  limit: z.coerce.number().int().catch(DEFAULT_LIMIT),
  offset: z.coerce.number().int().catch(0),
});

/** One canvas as the gallery API returns it — display-only. */
export interface GalleryItemDto {
  id: string;
  slug: string;
  url: string;
  title: string;
  summary: string | null;
  tags: string[];
  /** Whether a non-owner may clone this canvas as a template (plan 002). Listed
   *  canvases are always unprotected now, so `hasPassword` is gone from this DTO. */
  templatable: boolean;
  publishedAt: number | null;
  /** `owner.id` is the opaque user uuid (plan 004) — the stable owner-filter key.
   *  Never the owner's email or any internal flag. */
  owner: { id: string; name: string; avatarUrl: string | null };
}

export interface GalleryPageDto {
  items: GalleryItemDto[];
  total: number;
  limit: number;
  offset: number;
}

/** The pickable owner/tag lists for the gallery filter UI (plan 004). Owners carry
 *  display identity + the opaque filter id only — never email/internal flags. */
export interface GalleryFacetsDto {
  owners: Array<{ id: string; name: string; avatarUrl: string | null }>;
  tags: string[];
}

/** Display-only projection of a gallery row — explicit field list, never a spread
 *  of the canvas/user row, so api_key_hash / password_hash / owner email / internal
 *  flags can never leak (§12.0 #1). */
function galleryItem(config: Config, row: GalleryRow): GalleryItemDto {
  const cv = row.canvas;
  // gallery_tags is a JSON column; it is only ever written via the settings route
  // (validated as string[]), but project defensively so the string[] contract holds
  // even against legacy/hand-edited data.
  const tags = Array.isArray(cv.galleryTags)
    ? cv.galleryTags.filter((t): t is string => typeof t === "string")
    : [];
  return {
    id: cv.id,
    slug: cv.slug,
    url: canvasUrl(config, cv.slug),
    title: cv.title,
    summary: cv.gallerySummary,
    tags,
    templatable: cv.galleryTemplatable,
    publishedAt: cv.galleryPublishedAt,
    owner: { id: row.ownerId, name: row.ownerName, avatarUrl: row.ownerAvatarUrl },
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
    const data = parsed.success
      ? parsed.data
      : {
          q: undefined,
          tag: undefined,
          owner: undefined,
          templatable: false,
          sort: "published" as const,
          limit: DEFAULT_LIMIT,
          offset: 0,
        };
    const limit = Math.min(Math.max(data.limit, 1), MAX_LIMIT);
    const offset = Math.max(data.offset, 0);

    const { items, total } = await deps.canvases.listGallery({
      now: Date.now(),
      q: data.q,
      tag: data.tag,
      owner: data.owner,
      templatable: data.templatable,
      sort: data.sort,
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

  // Pickable owner/tag lists for the filter UI (plan 004). Same session gateway,
  // same visibility predicate as the browse — facets can only reference owners/tags
  // whose canvas is currently visible. Owners are projected by the repo to
  // {id,name,avatarUrl} only; re-state the explicit shape here so a future repo
  // change can't silently widen what the route returns (§12).
  app.get("/facets", async (c) => {
    const { owners, tags } = await deps.canvases.listGalleryFacets(Date.now());
    const dto: GalleryFacetsDto = {
      owners: owners.map((o) => ({ id: o.id, name: o.name, avatarUrl: o.avatarUrl })),
      tags,
    };
    return c.json(dto);
  });

  return app;
}
