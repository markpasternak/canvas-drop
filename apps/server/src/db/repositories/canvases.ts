import { computeSearchText, searchTextPatterns } from "@canvas-drop/shared";
import { FEATURE_CAPABILITIES, FEATURE_COLUMN } from "@canvas-drop/shared/capabilities";
import {
  type AccessRung,
  type AllowlistPrincipalKind,
  type Canvas,
  type CanvasStatus,
  type Json,
  type PreviewMode,
  pgSchema,
  sqliteSchema,
} from "@canvas-drop/shared/db";
import {
  and,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

/**
 * The share + gallery columns cleared whenever a canvas leaves the Published
 * state (unpublish, archive) — invariant: listed ⟹ shared ⟹ published. The repo
 * writes spread this into their `.set()`; the management routes spread it into the
 * returned view (which is built from the pre-mutation row), so the DB write and
 * the optimistic response can never clear different fields. One source of truth.
 */
export const CLEARED_PUBLICATION_FIELDS = {
  access: "private",
  sharedExpiresAt: null,
  galleryListed: false,
  galleryTemplatable: false,
  galleryPublishedAt: null,
} as const;

export interface CreateCanvasInput {
  ownerId: string;
  slug: string;
  /** True when the slug was owner-chosen rather than randomly generated. Defaults false. */
  slugCustom?: boolean;
  apiKeyHash: string;
  title?: string;
  description?: string | null;
  /** Backend-group master switch (plan 006). Defaults off; cap_* columns default on. */
  backendEnabled?: boolean;
  /**
   * Clone-only seed fields (plan 002). Defaults preserve the normal create path:
   * no password, version 0, and no lineage. The clone service copies the source's
   * password hash/version verbatim (the gate grant is per-canvas, so a copied hash
   * is safe) and records the source canvas for lineage.
   */
  passwordHash?: string | null;
  passwordVersion?: number;
  clonedFromCanvasId?: string | null;
}

/**
 * Capability patch (plan 006). Undefined fields are left unchanged. Turning
 * `backendEnabled` off does NOT clear the feature flags — they persist so
 * re-enabling backend restores the prior per-feature choices (KTD-2).
 */
export interface CanvasCapabilitiesPatch {
  backendEnabled?: boolean;
  kv?: boolean;
  files?: boolean;
  ai?: boolean;
  realtime?: boolean;
}

/** Mutable settings (§6.3). Undefined fields are left unchanged. */
export interface CanvasSettingsPatch {
  title?: string;
  description?: string | null;
  access?: AccessRung;
  guestAiEnabled?: boolean;
  guestAiCap?: number;
  sharedExpiresAt?: number | null;
  spaFallback?: boolean;
  previewMode?: PreviewMode;
  galleryListed?: boolean;
  galleryTemplatable?: boolean;
  gallerySummary?: string | null;
  tags?: Json;
}

/**
 * Gallery sort axes (plan 004). `published` is the default and matches the legacy
 * fixed order (most-recently-published first). `updated` orders by last change;
 * `title` is case-insensitive A–Z. An unknown value falls back to `published` at
 * the route, so the repo only ever receives one of these three.
 */
export type GallerySort = "published" | "updated" | "title";

/**
 * Options for the opt-in gallery listing (plan 008 / M8; filters + sort plan 004).
 * Pagination is offset-based; `now` is supplied by the caller (one timestamp at the
 * route) so the expiry clause is deterministic and testable, mirroring
 * `decideCanvasAccess`. `owner`/`templatable`/`sort` are AND-ed onto the fixed
 * visibility predicate — they never widen it (§12).
 */
export interface GalleryListOptions {
  now: number;
  q?: string;
  tag?: string;
  /** Filter to a single owner by opaque user id (plan 004). */
  owner?: string;
  /** When true, return only canvases a non-owner may clone (plan 004). */
  templatable?: boolean;
  /** Sort axis; defaults to `published` when omitted (plan 004). */
  sort?: GallerySort;
  limit: number;
  offset: number;
}

/**
 * A gallery row: the full canvas plus the owner's display identity. `ownerId` is
 * the opaque user uuid (plan 004) used as the stable owner-filter key — never the
 * owner's email or any internal flag.
 */
export interface GalleryRow {
  canvas: Canvas;
  ownerId: string;
  ownerName: string;
  ownerAvatarUrl: string | null;
}

/** Distinct owners + tags across the currently-visible gallery (plan 004 facets). */
export interface GalleryFacets {
  owners: Array<{ id: string; name: string; avatarUrl: string | null }>;
  tags: string[];
}

/**
 * Your-canvases sort axes (plan 005; `popular` added plan 004 popularity).
 * `updated` is the default (most-recently changed first); `created` is newest-first
 * by creation; `title` is case-insensitive A–Z; `popular` ranks by trending views
 * over a recent window (see {@link OwnerListOptions.popularSinceMs}). An unknown
 * value falls back to `updated` at the route, so the repo only ever receives one of these.
 */
export type CanvasesSort = "updated" | "created" | "title" | "popular";

/** Default trending window for the `popular` sort when the caller passes none (30d). */
export const POPULAR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Options for the owner's own filtered/sorted/paginated list (plan 005). Every
 * filter ANDs onto the owner-scope base (`ownerId = me`, status not deleted/
 * archived); none may widen past the caller's own active set — the Your-canvases
 * analogue of the gallery visibility predicate (§12 owner-scope invariant).
 */
export interface OwnerListOptions {
  ownerId: string;
  q?: string;
  /** Access/gallery-state filters — each maps to one canvas column. */
  access?: AccessRung;
  shared?: boolean;
  protected?: boolean;
  listed?: boolean;
  template?: boolean;
  /** Deployment-state: no published version yet (`current_version_id IS NULL`). */
  neverDeployed?: boolean;
  /** Scope to the owner's ARCHIVED canvases instead of the active set (default). */
  archived?: boolean;
  sort?: CanvasesSort;
  /** Lower bound (epoch ms) for the `popular` sort's trending window; ignored by
   *  every other sort. Defaults to now − {@link POPULAR_WINDOW_MS} when omitted. */
  popularSinceMs?: number;
  limit: number;
  offset: number;
}

/** One canvas-allowlist entry (D4 `specific_people` rung). */
export interface AllowlistEntry {
  id: string;
  canvasId: string;
  principalKind: AllowlistPrincipalKind;
  userId: string | null;
  email: string | null;
  createdAt: number;
}

export interface OwnerCanvasSummary {
  active: number;
  archived: number;
  shared: number;
  protected: number;
  listed: number;
  templates: number;
  neverDeployed: number;
}

/**
 * Canvases repository (§10). Dual-dialect seam typed `any` (KTD-1); inputs and
 * the {@link Canvas} row shape stay strongly typed.
 */
export function canvasesRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.canvases : pgSchema.canvases;
  const versionsT = client.dialect === "sqlite" ? sqliteSchema.versions : pgSchema.versions;
  const usersT = client.dialect === "sqlite" ? sqliteSchema.users : pgSchema.users;
  const allowlistT =
    client.dialect === "sqlite" ? sqliteSchema.canvasAllowlist : pgSchema.canvasAllowlist;

  /**
   * The §12 gallery-visibility predicate, shared by {@link listGallery} and the
   * clone-eligibility check ({@link findCloneableTemplate}) so "is this in the
   * gallery" and "may a non-owner clone this" can never drift apart (plan 002
   * KTD4). A canvas is visible only when it is active, shared, listed, unexpired,
   * published, AND unprotected — the `password_hash IS NULL` clause makes a
   * protected canvas invisible even if a stale row still has it listed (plan 002
   * R10, reversing the M8 "protected canvases are listed" decision).
   */
  const galleryVisibilityFilters = (now: number) => [
    eq(t.status, "active"),
    // Gallery-eligible = org-visible or public (the former `shared = true`).
    inArray(t.access, ["whole_org", "public_link"]),
    eq(t.galleryListed, true),
    or(isNull(t.sharedExpiresAt), gt(t.sharedExpiresAt, now)),
    isNotNull(t.currentVersionId),
    isNull(t.passwordHash),
  ];

  /**
   * The forgiving `?q=` predicate (plan 2026-06-19 KTD1), shared by
   * {@link listByOwnerFiltered} and {@link listGallery} so the owner list and the
   * public gallery search the SAME normalized blob with the SAME semantics. Each
   * whitespace-separated token of `normalize(q)` is matched with an escaped
   * `LIKE '%token%' ESCAPE '\'` against `search_text`, AND-ed together (a row must
   * contain every token). Returns `undefined` for an empty/all-whitespace query so
   * the caller adds no filter. `search_text` is nullable; `lower(coalesce(...,''))`
   * keeps an un-backfilled NULL row out of every match rather than throwing.
   */
  const searchTextPredicate = (rawQuery: string | undefined): SQL | undefined => {
    if (!rawQuery) return undefined;
    const patterns = searchTextPatterns(rawQuery);
    if (patterns.length === 0) return undefined;
    return and(
      ...patterns.map(
        (pattern) => sql`lower(coalesce(${t.searchText}, '')) like ${pattern} escape '\\'`,
      ),
    );
  };

  /**
   * Recompute + persist the denormalized `search_text` for one canvas from its
   * current title/summary/tags/slug (plan 2026-06-19 KTD1). Invoked AFTER any write
   * that touches those fields (updateSettings, regenerateSlug). Reads the post-write
   * row so the blob reflects the merged final state — the patch alone can't, since
   * it may omit fields the blob still depends on. A no-op if the row vanished.
   */
  const recomputeSearchText = async (id: string): Promise<void> => {
    const rows = (await db
      .select({
        title: t.title,
        gallerySummary: t.gallerySummary,
        tags: t.tags,
        slug: t.slug,
      })
      .from(t)
      .where(eq(t.id, id))
      .limit(1)) as Array<{
      title: string;
      gallerySummary: string | null;
      tags: unknown;
      slug: string;
    }>;
    const row = rows[0];
    if (!row) return;
    const searchText = computeSearchText({
      title: row.title,
      gallerySummary: row.gallerySummary,
      tags: Array.isArray(row.tags) ? (row.tags as string[]) : null,
      slug: row.slug,
    });
    await db.update(t).set({ searchText }).where(eq(t.id, id));
  };

  return {
    async create(input: CreateCanvasInput): Promise<Canvas> {
      const now = Date.now();
      const title = input.title ?? "";
      const rows = await db
        .insert(t)
        .values({
          id: uuidv7(),
          slug: input.slug,
          slugCustom: input.slugCustom ?? false,
          title,
          description: input.description ?? null,
          // Seed the search blob from the create-time fields (no summary/tags yet);
          // recomputed on every later write that touches title/summary/tags/slug.
          searchText: computeSearchText({
            title,
            gallerySummary: null,
            tags: null,
            slug: input.slug,
          }),
          ownerId: input.ownerId,
          access: "private",
          galleryListed: false,
          galleryTemplatable: false,
          passwordHash: input.passwordHash ?? null,
          passwordVersion: input.passwordVersion ?? 0,
          clonedFromCanvasId: input.clonedFromCanvasId ?? null,
          spaFallback: false,
          // Capability defaults: backend off unless requested; cap_* fall back to
          // their column defaults (all on), so an enabled canvas has all features on.
          backendEnabled: input.backendEnabled ?? false,
          apiKeyHash: input.apiKeyHash,
          status: "active",
          currentVersionId: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return rows[0] as Canvas;
    },

    /** Find by slug. Excludes soft-deleted canvases (a regenerated/old slug 404s). */
    async findBySlug(slug: string): Promise<Canvas | null> {
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.slug, slug), ne(t.status, "deleted")))
        .limit(1);
      return (rows[0] as Canvas | undefined) ?? null;
    },

    /**
     * Is this slug present at all — INCLUDING soft-deleted rows (plan 004, KTD8)?
     * `canvases_slug_uq` is unconditional, so a slug held by a `deleted` tombstone
     * still blocks an insert. The availability check must agree with the index
     * (status-unaware), unlike `findBySlug` which hides deleted rows.
     */
    async slugTaken(slug: string): Promise<boolean> {
      const rows = await db.select({ id: t.id }).from(t).where(eq(t.slug, slug)).limit(1);
      return rows.length > 0;
    },

    async findById(id: string): Promise<Canvas | null> {
      const rows = await db.select().from(t).where(eq(t.id, id)).limit(1);
      return (rows[0] as Canvas | undefined) ?? null;
    },

    /** Batched lookup (any status) for enriching admin top-N lists — no N+1. */
    async findByIds(ids: readonly string[]): Promise<Canvas[]> {
      if (ids.length === 0) return [];
      return (await db
        .select()
        .from(t)
        .where(inArray(t.id, [...ids]))) as Canvas[];
    },

    /**
     * Your-canvases list with server-side filter/search/sort + offset pagination
     * (plan 005). Mirrors {@link listGallery}'s shape. The owner-scope base
     * (`ownerId = me`, status not deleted/archived) is the fixed first two filters;
     * every option ANDs onto it and can only ever shrink the owner's active set —
     * a missing/malformed option still returns only the caller's canvases (§12).
     * Two-query count posture (no new index) at single-org scale, like the gallery.
     *
     * For `sort=popular` the result also carries `recentViews` — the page's trending
     * counts the ranking already computed — so the caller reuses them for the per-row
     * display instead of re-aggregating `usage_events` a second time (plan 004). It is
     * undefined for every other sort (the caller aggregates the page itself there).
     */
    async listByOwnerFiltered(
      opts: OwnerListOptions,
    ): Promise<{ items: Canvas[]; total: number; recentViews?: Map<string, number> }> {
      // Typed to allow `or(...)` (which is SQL | undefined) to be pushed, matching
      // the gallery's filter-array shape that `and(...)` accepts.
      const filters: Array<SQL | undefined> = [
        eq(t.ownerId, opts.ownerId),
        // Default scope is the active set (excludes archived + deleted); the
        // `archived` scope lists ONLY archived canvases (the Your-canvases toggle).
        opts.archived ? eq(t.status, "archived") : notInArray(t.status, ["deleted", "archived"]),
      ];

      // Forgiving normalized-substring search over the shared `search_text` blob
      // (plan 2026-06-19 KTD1) — the SAME predicate the gallery uses, so the owner
      // list and gallery search title + summary + tags + slug identically.
      filters.push(searchTextPredicate(opts.q));

      // Column-based state filters (plan 005 KTD3). `protected` keys off a set
      // password hash; `neverDeployed` off the absence of a published version.
      if (opts.access) filters.push(eq(t.access, opts.access));
      if (opts.shared) filters.push(ne(t.access, "private"));
      if (opts.protected) filters.push(isNotNull(t.passwordHash));
      if (opts.listed) filters.push(eq(t.galleryListed, true));
      if (opts.template) filters.push(eq(t.galleryTemplatable, true));
      if (opts.neverDeployed) filters.push(isNull(t.currentVersionId));

      const where = and(...filters);

      // Trending sort (plan 004): rank the WHOLE filtered owner set by recent views,
      // then paginate. Kept off the default path on purpose — only this opt-in sort
      // pays the usage aggregate. Two bounded queries (filtered ids, then one grouped
      // count over the recent window riding `usage_events(canvasId, createdAt)`), the
      // ranking + slice in JS, then a hydrate of just the page. At single-org scale the
      // owner's id set is small and the window is 90-day-pruned, so this stays cheap.
      if (opts.sort === "popular") {
        const sinceMs = opts.popularSinceMs ?? Date.now() - POPULAR_WINDOW_MS;
        const idRows = (await db
          .select({ id: t.id, updatedAt: t.updatedAt })
          .from(t)
          .where(where)) as Array<{ id: string; updatedAt: number }>;
        const total = idRows.length;
        if (total === 0) return { items: [], total: 0, recentViews: new Map() };

        const ue = client.dialect === "sqlite" ? sqliteSchema.usageEvents : pgSchema.usageEvents;
        const countRows = (await db
          .select({ canvasId: ue.canvasId, c: sql<number>`count(*)` })
          .from(ue)
          .where(
            and(
              eq(ue.type, "view"),
              gte(ue.createdAt, sinceMs),
              inArray(
                ue.canvasId,
                idRows.map((r) => r.id),
              ),
            ),
          )
          .groupBy(ue.canvasId)) as Array<{ canvasId: string; c: number }>;
        const views = new Map(countRows.map((r) => [r.canvasId, Number(r.c)]));

        // (recent views desc, updatedAt desc, id desc) — same id tiebreak as the SQL
        // sorts (uuidv7 monotonic) so equal-popularity pages stay stable.
        const pageIds = idRows
          .map((r) => ({ id: r.id, updatedAt: Number(r.updatedAt), v: views.get(r.id) ?? 0 }))
          .sort((a, b) => b.v - a.v || b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
          .slice(opts.offset, opts.offset + opts.limit)
          .map((r) => r.id);
        if (pageIds.length === 0) return { items: [], total, recentViews: new Map() };

        const byId = new Map(
          ((await db.select().from(t).where(inArray(t.id, pageIds))) as Canvas[]).map((cv) => [
            cv.id,
            cv,
          ]),
        );
        const items = pageIds
          .map((id) => byId.get(id))
          .filter((cv): cv is Canvas => cv !== undefined);
        // Hand the page's trending counts back so the caller doesn't re-aggregate
        // `usage_events` for the same rows (the ranking already has them).
        const recentViews = new Map(pageIds.map((id) => [id, views.get(id) ?? 0]));
        return { items, total, recentViews };
      }

      // Default is most-recently-updated; `created` and `title` are alternatives.
      // Every axis keeps an `id` tiebreak (uuidv7 monotonic) so pages don't shuffle
      // within an equal sort key — same convention as listGallery.
      const orderBy =
        opts.sort === "created"
          ? [desc(t.createdAt), desc(t.id)]
          : opts.sort === "title"
            ? [sql`lower(${t.title}) asc`, desc(t.id)]
            : [desc(t.updatedAt), desc(t.id)];

      const rows = (await db
        .select()
        .from(t)
        .where(where)
        .orderBy(...orderBy)
        .limit(opts.limit)
        .offset(opts.offset)) as Canvas[];

      const totalRows = (await db.select({ value: count() }).from(t).where(where)) as Array<{
        value: number;
      }>;

      return { items: rows, total: totalRows[0]?.value ?? 0 };
    },

    /**
     * Owner-scoped inventory counts for the Your-canvases dashboard. Counts are
     * intentionally independent of the current search/filter so they explain the
     * whole personal inventory and can annotate filter chips honestly.
     */
    async ownerSummary(ownerId: string): Promise<OwnerCanvasSummary> {
      // Single pass: conditional aggregation over the owner's rows instead of seven
      // serial COUNT round-trips. Each bucket is `sum(case when <cond> then 1 else 0
      // end)`; the conditions are drizzle SQL objects so they render correctly on
      // both dialects (the same predicates the filtered list uses). `active` excludes
      // deleted/archived; the rest AND onto that, except `archived` which is its own
      // status slice. Counts stay independent of the current search/filter.
      const isActive = notInArray(t.status, ["deleted", "archived"]);
      const sumCase = (cond: SQL | undefined) =>
        sql<number>`sum(case when ${cond} then 1 else 0 end)`;
      const rows = (await db
        .select({
          active: sumCase(isActive),
          archived: sumCase(eq(t.status, "archived")),
          shared: sumCase(and(isActive, ne(t.access, "private"))),
          protected: sumCase(and(isActive, isNotNull(t.passwordHash))),
          listed: sumCase(and(isActive, eq(t.galleryListed, true))),
          templates: sumCase(and(isActive, eq(t.galleryTemplatable, true))),
          neverDeployed: sumCase(and(isActive, isNull(t.currentVersionId))),
        })
        .from(t)
        .where(eq(t.ownerId, ownerId))) as Array<Record<keyof OwnerCanvasSummary, number | null>>;
      const r = rows[0];

      return {
        active: Number(r?.active ?? 0),
        archived: Number(r?.archived ?? 0),
        shared: Number(r?.shared ?? 0),
        protected: Number(r?.protected ?? 0),
        listed: Number(r?.listed ?? 0),
        templates: Number(r?.templates ?? 0),
        neverDeployed: Number(r?.neverDeployed ?? 0),
      };
    },

    async updateSettings(id: string, patch: CanvasSettingsPatch): Promise<Canvas> {
      const set: Record<string, unknown> = { updatedAt: Date.now() };
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.spaFallback !== undefined) set.spaFallback = patch.spaFallback;
      if (patch.previewMode !== undefined) set.previewMode = patch.previewMode;
      if (patch.sharedExpiresAt !== undefined) set.sharedExpiresAt = patch.sharedExpiresAt;
      if (patch.galleryListed !== undefined) {
        set.galleryListed = patch.galleryListed;
        set.galleryPublishedAt = patch.galleryListed ? Date.now() : null;
      }
      if (patch.galleryTemplatable !== undefined) set.galleryTemplatable = patch.galleryTemplatable;
      // Invariant (KTD6): templatable ⊆ listed. Un-listing in this same patch always
      // clears templatable, overriding any templatable=true in the same call.
      if (patch.galleryListed === false) set.galleryTemplatable = false;
      if (patch.gallerySummary !== undefined) set.gallerySummary = patch.gallerySummary;
      if (patch.tags !== undefined) set.tags = patch.tags;
      if (patch.access !== undefined) set.access = patch.access;
      if (patch.guestAiEnabled !== undefined) set.guestAiEnabled = patch.guestAiEnabled;
      if (patch.guestAiCap !== undefined) set.guestAiCap = patch.guestAiCap;
      const rows = await db.update(t).set(set).where(eq(t.id, id)).returning();
      // Recompute the search blob when this patch touched any of its inputs
      // (title/summary/tags — slug is owned by regenerateSlug). Reads the merged
      // post-write state so omitted-but-depended-on fields stay correct.
      if (
        patch.title !== undefined ||
        patch.gallerySummary !== undefined ||
        patch.tags !== undefined
      ) {
        await recomputeSearchText(id);
        const refreshed = (await db.select().from(t).where(eq(t.id, id)).limit(1)) as Canvas[];
        return (refreshed[0] ?? rows[0]) as Canvas;
      }
      return rows[0] as Canvas;
    },

    /** Revoke-sweep (U10): flip an owner's public_link canvases back to private when
     *  an admin removes their publish-public capability. Atomic single UPDATE. */
    async revertPublicForOwner(ownerId: string): Promise<void> {
      await db
        .update(t)
        // Clear the full publication field set, not just `access` — leaving
        // galleryListed/galleryTemplatable/galleryPublishedAt set would keep stale
        // listed/template counts in ownerSummary and listByOwnerFiltered (which
        // match on galleryListed alone). Mirrors archive/unpublish.
        .set({ ...CLEARED_PUBLICATION_FIELDS, updatedAt: Date.now() })
        .where(and(eq(t.ownerId, ownerId), eq(t.access, "public_link")));
    },

    /** Set the access rung directly (D4 ladder). Used by the settings route and the
     *  publish-public revoke sweep (U10). */
    async setAccess(id: string, access: AccessRung): Promise<Canvas> {
      const rows = await db
        .update(t)
        .set({ access, updatedAt: Date.now() })
        .where(eq(t.id, id))
        .returning();
      return rows[0] as Canvas;
    },

    /** All allowlist entries for a canvas (D4 `specific_people`), oldest first. */
    async listAllowlist(canvasId: string): Promise<AllowlistEntry[]> {
      return (await db
        .select()
        .from(allowlistT)
        .where(eq(allowlistT.canvasId, canvasId))
        .orderBy(allowlistT.createdAt)) as AllowlistEntry[];
    },

    /**
     * Add one allowlist entry. Atomic upsert on the (canvas, user_id) /
     * (canvas, email) unique index so a concurrent duplicate invite is a no-op,
     * not a constraint crash. Returns the resulting entry.
     */
    async addAllowlistEntry(input: {
      canvasId: string;
      principalKind: AllowlistPrincipalKind;
      userId?: string | null;
      email?: string | null;
    }): Promise<AllowlistEntry> {
      const conflictTarget =
        input.principalKind === "member" ? allowlistT.userId : allowlistT.email;
      const rows = await db
        .insert(allowlistT)
        .values({
          id: uuidv7(),
          canvasId: input.canvasId,
          principalKind: input.principalKind,
          userId: input.userId ?? null,
          email: input.email ?? null,
          createdAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: [allowlistT.canvasId, conflictTarget],
          // No-op update so the existing row is returned rather than crashing.
          set: { canvasId: input.canvasId },
        })
        .returning();
      return rows[0] as AllowlistEntry;
    },

    /** Remove an allowlist entry by its id (scoped to the canvas for safety). */
    async removeAllowlistEntry(canvasId: string, entryId: string): Promise<void> {
      await db
        .delete(allowlistT)
        .where(and(eq(allowlistT.canvasId, canvasId), eq(allowlistT.id, entryId)));
    },

    /**
     * The single canonical allowlist membership check (D4). True when the given
     * principal is on the canvas's allowlist: a `member` matches by user_id, a
     * `guest` matches by email. Every access-decision caller routes through this so
     * the predicate can't drift across the content chain / runtime API / realtime.
     */
    async isPrincipalAllowed(
      canvasId: string,
      principal: { userId?: string | null; email?: string | null },
    ): Promise<boolean> {
      const match =
        principal.userId != null
          ? eq(allowlistT.userId, principal.userId)
          : principal.email != null
            ? eq(allowlistT.email, principal.email)
            : null;
      if (!match) return false;
      const rows = (await db
        .select({ id: allowlistT.id })
        .from(allowlistT)
        .where(and(eq(allowlistT.canvasId, canvasId), match))
        .limit(1)) as Array<{ id: string }>;
      return rows.length > 0;
    },

    /**
     * Whether the owner account may currently publish public links (U10 capability).
     * The defense-in-depth half of the public_link gate: the admin revoke sweep
     * (revertPublicForOwner) flips canvases to private at write time, and this
     * per-request check makes the decision table self-sufficient if a public_link
     * row ever outlives the owner's grant. A missing owner reads as not-enabled.
     */
    async isOwnerPublishEnabled(ownerId: string): Promise<boolean> {
      const rows = (await db
        .select({ canPublishPublic: usersT.canPublishPublic })
        .from(usersT)
        .where(eq(usersT.id, ownerId))
        .limit(1)) as Array<{ canPublishPublic: boolean }>;
      return rows[0]?.canPublishPublic === true;
    },

    /**
     * Update capability flags (plan 006). Writes only the fields present in the
     * patch; turning backend off never clears the feature flags (KTD-2).
     */
    async updateCapabilities(id: string, patch: CanvasCapabilitiesPatch): Promise<Canvas> {
      const set: Record<string, unknown> = { updatedAt: Date.now() };
      if (patch.backendEnabled !== undefined) set.backendEnabled = patch.backendEnabled;
      // Map each present feature flag to its column via the shared taxonomy, so the
      // cap→column mapping has one source of truth (FEATURE_COLUMN).
      for (const cap of FEATURE_CAPABILITIES) {
        const value = patch[cap];
        if (value !== undefined) set[FEATURE_COLUMN[cap]] = value;
      }
      const rows = await db.update(t).set(set).where(eq(t.id, id)).returning();
      return rows[0] as Canvas;
    },

    /** Set or clear the password hash; bump passwordVersion to invalidate gate cookies (U16). */
    async setPassword(id: string, passwordHash: string | null): Promise<Canvas> {
      // Atomic increment (no read-then-write TOCTOU): concurrent password changes
      // never collide on a stale passwordVersion.
      const rows = await db
        .update(t)
        .set({
          passwordHash,
          passwordVersion: sql`${t.passwordVersion} + 1`,
          updatedAt: Date.now(),
        })
        .where(eq(t.id, id))
        .returning();
      return rows[0] as Canvas;
    },

    async regenerateSlug(id: string, newSlug: string, custom = false): Promise<Canvas> {
      const rows = (await db
        .update(t)
        .set({ slug: newSlug, slugCustom: custom, updatedAt: Date.now() })
        .where(eq(t.id, id))
        .returning()) as Canvas[];
      // The slug is part of the search blob — recompute it so search-by-new-slug
      // hits and the old slug no longer does, then return the refreshed row.
      await recomputeSearchText(id);
      const refreshed = (await db.select().from(t).where(eq(t.id, id)).limit(1)) as Canvas[];
      return (refreshed[0] ?? rows[0]) as Canvas;
    },

    async regenerateApiKey(id: string, apiKeyHash: string): Promise<Canvas> {
      const rows = await db
        .update(t)
        .set({ apiKeyHash, updatedAt: Date.now() })
        .where(eq(t.id, id))
        .returning();
      return rows[0] as Canvas;
    },

    async setStatus(id: string, status: CanvasStatus): Promise<void> {
      const set: Record<string, unknown> = { status, updatedAt: Date.now() };
      if (status === "deleted") set.deletedAt = Date.now();
      await db.update(t).set(set).where(eq(t.id, id));
    },

    /**
     * Archive a canvas (owner-initiated, reversible). Guarded to fire ONLY from
     * `active`: archiving a `disabled` row would let an owner archive→unarchive
     * back to active and silently reverse an admin takedown (§12.0 #5, M7
     * adversarial review). A deleted tombstone is likewise never resurrected.
     * Returns false when the row is missing or not active, so the route 409s
     * instead of silently no-opping. Does NOT touch `deletedAt`.
     */
    async archive(id: string): Promise<boolean> {
      const rows = (await db
        .update(t)
        // Archiving leaves the published state, so it reverts sharing and gallery
        // listing too (invariant: listed ⟹ shared ⟹ published). Unarchive restores
        // the canvas at the same URL; the owner re-shares deliberately.
        .set({ status: "archived", ...CLEARED_PUBLICATION_FIELDS, updatedAt: Date.now() })
        .where(and(eq(t.id, id), eq(t.status, "active")))
        .returning({ id: t.id })) as Array<{ id: string }>;
      return rows.length > 0;
    },

    /**
     * Unarchive a canvas back to active. Guarded to only apply to a currently
     * archived row — unarchiving a non-archived canvas returns false so the route
     * can reject the invalid transition rather than flipping an active/disabled
     * canvas's status out from under it.
     */
    async unarchive(id: string): Promise<boolean> {
      const rows = (await db
        .update(t)
        .set({ status: "active", updatedAt: Date.now() })
        .where(and(eq(t.id, id), eq(t.status, "archived")))
        .returning({ id: t.id })) as Array<{ id: string }>;
      return rows.length > 0;
    },

    /**
     * Admin takedown (§6.10.2, M7). Guarded to fire ONLY from `active` (an
     * archived/deleted canvas already 404s publicly — disabling it adds nothing,
     * and the guard keeps the state machine honest). Stores the owner-facing
     * `disabledReason`. Returns false for any non-active row so the route 409s
     * `NOT_ACTIVE`.
     */
    async setDisabled(id: string, reason: string): Promise<boolean> {
      const rows = (await db
        .update(t)
        .set({ status: "disabled", disabledReason: reason, updatedAt: Date.now() })
        .where(and(eq(t.id, id), eq(t.status, "active")))
        .returning({ id: t.id })) as Array<{ id: string }>;
      return rows.length > 0;
    },

    /**
     * Admin re-enable of a disabled canvas. Guarded to a currently `disabled`
     * row; clears `disabledReason` so no stale takedown note survives. Returns
     * false for a non-disabled row.
     */
    async enable(id: string): Promise<boolean> {
      const rows = (await db
        .update(t)
        .set({ status: "active", disabledReason: null, updatedAt: Date.now() })
        .where(and(eq(t.id, id), eq(t.status, "disabled")))
        .returning({ id: t.id })) as Array<{ id: string }>;
      return rows.length > 0;
    },

    /**
     * Admin restore of a soft-deleted canvas (§6.10.5, M7). Guarded to a
     * currently `deleted` row; clears `deletedAt` so the row leaves the purge
     * sweep and is live again. Returns false for a non-deleted row.
     */
    async restore(id: string): Promise<boolean> {
      const rows = (await db
        .update(t)
        // Clear disabledReason too — a deleted canvas that was previously disabled
        // must not carry a stale takedown note onto the restored (active) row.
        .set({ status: "active", deletedAt: null, disabledReason: null, updatedAt: Date.now() })
        .where(and(eq(t.id, id), eq(t.status, "deleted")))
        .returning({ id: t.id })) as Array<{ id: string }>;
      return rows.length > 0;
    },

    async setCurrentVersion(id: string, versionId: string): Promise<void> {
      await db
        .update(t)
        .set({ currentVersionId: versionId, updatedAt: Date.now() })
        .where(eq(t.id, id));
    },

    /**
     * Point the canvas at `versionId` ONLY if that version is currently ready —
     * the swap and the readiness check are one atomic UPDATE (`WHERE id=? AND
     * EXISTS(ready version)`). Returns false when the target vanished (a
     * concurrent prune deleted it), so the rollback caller surfaces a clean error
     * instead of writing a pointer to a missing version. Pairs with
     * `versionsRepository.pruneBeyond`'s live-pointer guard to close the
     * rollback-vs-prune race without a cross-dialect transaction.
     */
    async setCurrentVersionIfReady(id: string, versionId: string): Promise<boolean> {
      const rows = (await db
        .update(t)
        .set({ currentVersionId: versionId, updatedAt: Date.now() })
        .where(
          and(
            eq(t.id, id),
            exists(
              db
                .select({ ok: sql`1` })
                .from(versionsT)
                .where(
                  and(
                    eq(versionsT.id, versionId),
                    eq(versionsT.canvasId, id),
                    eq(versionsT.status, "ready"),
                  ),
                ),
            ),
          ),
        )
        .returning({ id: t.id })) as Array<{ id: string }>;
      return rows.length > 0;
    },

    /**
     * Unpublish (owner-initiated, reversible): take a published canvas back to the
     * Draft state. Clears the current-version pointer (the public URL then 404s),
     * reverts sharing, AND clears gallery listing in the same write — leaving the
     * published state reverts share (invariant: shared ⟹ published), and a Draft
     * canvas can't sit in the gallery (listed ⟹ shared). Guarded to fire ONLY from
     * an `active` row that currently has a published version, so the route 409s on a
     * Draft/archived/disabled canvas instead of silently no-opping. The draft and
     * version history are untouched; re-publishing (and re-sharing) brings it back.
     */
    async unpublish(id: string): Promise<boolean> {
      const rows = (await db
        .update(t)
        .set({ currentVersionId: null, ...CLEARED_PUBLICATION_FIELDS, updatedAt: Date.now() })
        .where(and(eq(t.id, id), eq(t.status, "active"), isNotNull(t.currentVersionId)))
        .returning({ id: t.id })) as Array<{ id: string }>;
      return rows.length > 0;
    },

    /**
     * Soft-deleted canvases eligible for a purge sweep. `cutoffMs === null`
     * returns every deleted canvas; a number returns only those soft-deleted at
     * or before the cutoff (the retention window). Oldest deletions first.
     */
    async listDeletedBefore(cutoffMs: number | null): Promise<Canvas[]> {
      const where =
        cutoffMs === null
          ? eq(t.status, "deleted")
          : and(eq(t.status, "deleted"), lte(t.deletedAt, cutoffMs));
      return (await db.select().from(t).where(where).orderBy(t.deletedAt)) as Canvas[];
    },

    /**
     * Clear the current-version pointer (purge). After a sweep hard-deletes a
     * soft-deleted canvas's versions, the row is kept as a tombstone but its
     * `currentVersionId` would dangle at a removed version — null it so nothing
     * references a row that no longer exists.
     */
    async clearCurrentVersion(id: string): Promise<void> {
      await db.update(t).set({ currentVersionId: null, updatedAt: Date.now() }).where(eq(t.id, id));
    },

    /** Find by API key hash (Bearer-key deploy API); active canvases only. */
    async findByApiKeyHash(apiKeyHash: string): Promise<Canvas | null> {
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.apiKeyHash, apiKeyHash), eq(t.status, "active")))
        .limit(1);
      return (rows[0] as Canvas | undefined) ?? null;
    },

    /**
     * Opt-in gallery listing (plan 008 / M8). Returns only canvases that are
     * simultaneously active, shared, gallery-listed, unexpired, AND have a
     * published version — the §12 visibility predicate, evaluated per request with
     * no cached grants, so revoke / expiry / archive / disable / delete / un-list
     * remove a canvas from the gallery on the very next call. The
     * `current_version_id IS NOT NULL` clause keeps a never-deployed (or
     * fully-pruned) canvas out of the gallery so it never renders as a dead link.
     *
     * Joins `users` for the owner's display identity (name + avatar only — no
     * email / internal flags reach this layer). Ordered most-recently-published
     * first with a stable `id` tiebreak. Returns the page plus the total count
     * under the same predicate for "showing X of N" pagination.
     */
    async listGallery(opts: GalleryListOptions): Promise<{ items: GalleryRow[]; total: number }> {
      const filters = galleryVisibilityFilters(opts.now);

      // Forgiving normalized-substring search over the shared `search_text` blob
      // (plan 2026-06-19 KTD1) — the SAME predicate the owner list uses, so both
      // surfaces search title + summary + tags + slug identically. LIKE
      // metacharacters in the user's text are escaped (ESCAPE '\').
      filters.push(searchTextPredicate(opts.q));

      if (opts.tag) {
        // JSON-array membership is the one genuinely dialect-divergent query.
        filters.push(
          client.dialect === "sqlite"
            ? sql`exists (select 1 from json_each(${t.tags}) where value = ${opts.tag})`
            : sql`${t.tags} @> ${JSON.stringify([opts.tag])}::jsonb`,
        );
      }

      // Filters AND onto the visibility predicate — they never widen it (§12). An
      // owner/templatable filter can only ever shrink the already-visible set.
      if (opts.owner) {
        filters.push(eq(t.ownerId, opts.owner));
      }
      if (opts.templatable) {
        filters.push(eq(t.galleryTemplatable, true));
      }

      const where = and(...filters);

      // Default order is most-recently-published with a stable `id` tiebreak
      // (uuidv7 monotonic). `updated` and `title` are the plan-004 alternatives;
      // `title` is case-insensitive A–Z. Every axis keeps the `id` tiebreak so
      // pages don't shuffle within an equal sort key.
      const orderBy =
        opts.sort === "updated"
          ? [desc(t.updatedAt), desc(t.id)]
          : opts.sort === "title"
            ? [sql`lower(${t.title}) asc`, desc(t.id)]
            : [desc(t.galleryPublishedAt), desc(t.id)];

      const rows = (await db
        .select({
          canvas: t,
          ownerId: usersT.id,
          ownerName: usersT.name,
          ownerAvatarUrl: usersT.avatarUrl,
        })
        .from(t)
        .innerJoin(usersT, eq(t.ownerId, usersT.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(opts.limit)
        .offset(opts.offset)) as GalleryRow[];

      const totalRows = (await db.select({ value: count() }).from(t).where(where)) as Array<{
        value: number;
      }>;

      return { items: rows, total: totalRows[0]?.value ?? 0 };
    },

    /**
     * Distinct owners + tags across the currently-visible gallery (plan 004), so
     * the filter UI can offer pickable lists. Reuses the SAME visibility predicate
     * as {@link listGallery} so a facet can never reference an owner/tag whose only
     * canvas is non-visible. Owners are projected to display identity + opaque id
     * ONLY — never email/internal flags (§12). Tags are flattened + deduped in JS
     * rather than via dialect-divergent JSON unnesting; at gallery scale (dozens of
     * rows) that is simplest and keeps the query dual-dialect-trivial.
     */
    async listGalleryFacets(now: number): Promise<GalleryFacets> {
      const where = and(...galleryVisibilityFilters(now));

      const owners = (await db
        .selectDistinct({ id: usersT.id, name: usersT.name, avatarUrl: usersT.avatarUrl })
        .from(t)
        .innerJoin(usersT, eq(t.ownerId, usersT.id))
        .where(where)
        .orderBy(usersT.name)) as GalleryFacets["owners"];

      const tagRows = (await db.select({ tags: t.tags }).from(t).where(where)) as Array<{
        tags: unknown;
      }>;
      const tagSet = new Set<string>();
      for (const row of tagRows) {
        if (Array.isArray(row.tags)) {
          for (const tag of row.tags) {
            if (typeof tag === "string") tagSet.add(tag);
          }
        }
      }

      return { owners, tags: [...tagSet].sort() };
    },

    /**
     * Clone-eligibility for a NON-owner (plan 002 R2): the canvas must satisfy the
     * exact gallery-visibility predicate AND be marked templatable. Returns the row
     * when cloneable, else null — the route 404s opaquely for null so a non-eligible
     * canvas's existence isn't revealed. Owners use their own path (no gate).
     */
    async findCloneableTemplate(id: string, now: number): Promise<Canvas | null> {
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), eq(t.galleryTemplatable, true), ...galleryVisibilityFilters(now)))
        .limit(1);
      return (rows[0] as Canvas | undefined) ?? null;
    },
  };
}

export type CanvasesRepository = ReturnType<typeof canvasesRepository>;
