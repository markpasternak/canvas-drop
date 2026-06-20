import { CANVAS_MAX_TAGS, type Config } from "@canvas-drop/shared";
import { Hono } from "hono";
import { z } from "zod";
import { canvasUrl } from "../canvas/url.js";
import type { CanvasesRepository, GalleryRow, GalleryScope } from "../db/repositories/canvases.js";
import type { AppEnv } from "../http/types.js";
import {
  type PreviewHintDeps,
  previewVisible,
  resolvePreviewIds,
} from "../screenshots/preview-ids.js";

/** Preview hint (plan 004) is optional: omitted → `hasPreview` false everywhere, so the
 *  gallery behaves exactly like today (GenerativeCover, no probe). */
export interface GalleryDeps extends PreviewHintDeps {
  config: Config;
  canvases: CanvasesRepository;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

/**
 * Browse-query schema. A gallery URL with a junk param should still render the
 * page, so invalid/absent values clamp to sane defaults rather than 400ing:
 * `limit` coerces + clamps to [1, 100] (default 30), `offset` clamps to >= 0
 * (default 0). `q` / `tag` are optional free text.
 */
const querySchema = z.object({
  q: z.string().trim().min(1).optional(),
  // Multi-tag any-match (single→multi 2026-06-19): repeated `?tag=a&tag=b` is read
  // off `c.req.queries("tag")` into a string[], so the gallery URL stays shareable.
  // Each tag is trimmed; empties are dropped. An empty list adds no tag filter.
  tag: z.array(z.string().trim().min(1)).optional(),
  // Owner filter is an opaque user id (plan 004). Templatable/featured coerce the
  // string query value to a boolean ("1"/"true" → true). Sort falls back to the
  // default axis on any unknown value, so a junk `sort` never 400s the browse.
  owner: z.string().trim().min(1).optional(),
  templatable: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  featured: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  sort: z
    .enum(["published", "recent", "updated", "title", "featured", "trending"])
    .catch("published"),
  limit: z.coerce.number().int().catch(DEFAULT_LIMIT),
  offset: z.coerce.number().int().catch(0),
});

/** One canvas as the gallery API returns it — display-only. */
export interface GalleryItemDto {
  id: string;
  slug: string;
  url: string;
  title: string;
  description: string | null;
  tags: string[];
  /** Whether a non-owner may clone this canvas as a template (plan 002). Listed
   *  canvases are always unprotected now, so `hasPassword` is gone from this DTO. */
  templatable: boolean;
  publishedAt: number | null;
  /** Admin-curated editorial flag (2026-06-19) — drives the Featured badge + the
   *  `featured` sort/filter. Display-only; the client never asserts it. */
  galleryFeatured: boolean;
  /** Trending views over the recent window (2026-06-19) — the count behind the
   *  `trending` sort, surfaced on every card. */
  recentViews: number;
  /** A captured screenshot preview exists for this canvas (plan 004) — drives the gallery
   *  cover the same way the owner dashboard does. False whenever the pipeline is off, so
   *  the gallery shows GenerativeCover and fires no wasted preview probe. */
  hasPreview: boolean;
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
function galleryItem(config: Config, row: GalleryRow, hasPreview: boolean): GalleryItemDto {
  const cv = row.canvas;
  // `tags` is a JSON column; it is only ever written via the settings route
  // (validated as string[]), but project defensively so the string[] contract holds
  // even against legacy/hand-edited data.
  const tags = Array.isArray(cv.tags)
    ? cv.tags.filter((t): t is string => typeof t === "string")
    : [];
  return {
    id: cv.id,
    slug: cv.slug,
    url: canvasUrl(config, cv.slug),
    title: cv.title,
    description: cv.description,
    tags,
    templatable: cv.galleryTemplatable,
    publishedAt: cv.galleryPublishedAt,
    galleryFeatured: cv.galleryFeatured,
    recentViews: row.recentViews,
    hasPreview,
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

  // Tenancy gallery scope (plan 002 U5): org-scope whole_org rows when an org is
  // configured, using the viewer's SERVER-resolved orgIds (never a client value). Inert
  // (no org) → the legacy org-agnostic gallery. The session gateway has already set
  // `orgIds` on the context before any gallery handler runs.
  const galleryScope = (c: import("hono").Context<AppEnv>): GalleryScope => ({
    tenancyActive: !!deps.config.org.name,
    viewerOrgIds: c.get("orgIds") ?? new Set<string>(),
  });

  app.get("/", async (c) => {
    // `c.req.query()` flattens repeated params to the first value; read `tag` via
    // `queries("tag")` so `?tag=a&tag=b` round-trips as an array (multi-tag any-match).
    // Cap at 20: a canvas carries at most 20 tags, so extra selections add cost, not matches.
    const tags = c.req.queries("tag")?.slice(0, CANVAS_MAX_TAGS);
    const parsed = querySchema.safeParse({
      ...c.req.query(),
      tag: tags && tags.length > 0 ? tags : undefined,
    });
    // safeParse only fails on a non-coercible shape; fall back to all-defaults so a
    // browse never errors on a malformed query string.
    const data = parsed.success
      ? parsed.data
      : {
          q: undefined,
          tag: undefined,
          owner: undefined,
          templatable: false,
          featured: false,
          sort: "published" as const,
          limit: DEFAULT_LIMIT,
          offset: 0,
        };
    const limit = Math.min(Math.max(data.limit, 1), MAX_LIMIT);
    const offset = Math.max(data.offset, 0);

    const { items, total } = await deps.canvases.listGallery({
      now: Date.now(),
      scope: galleryScope(c),
      q: data.q,
      tag: data.tag,
      owner: data.owner,
      templatable: data.templatable,
      featured: data.featured,
      sort: data.sort,
      limit,
      offset,
    });

    const previews = await resolvePreviewIds(
      deps,
      items.map((row) => row.canvas.id),
    );
    return c.json({
      items: items.map((row) =>
        galleryItem(deps.config, row, previewVisible(row.canvas, previews)),
      ),
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
    const { owners, tags } = await deps.canvases.listGalleryFacets(Date.now(), galleryScope(c));
    const dto: GalleryFacetsDto = {
      owners: owners.map((o) => ({ id: o.id, name: o.name, avatarUrl: o.avatarUrl })),
      tags,
    };
    return c.json(dto);
  });

  return app;
}
