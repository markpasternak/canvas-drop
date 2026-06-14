import { FEATURE_CAPABILITIES, FEATURE_COLUMN } from "@canvas-drop/shared/capabilities";
import {
  type Canvas,
  type CanvasStatus,
  type Json,
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
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

export interface CreateCanvasInput {
  ownerId: string;
  slug: string;
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
  shared?: boolean;
  sharedExpiresAt?: number | null;
  spaFallback?: boolean;
  galleryListed?: boolean;
  galleryTemplatable?: boolean;
  gallerySummary?: string | null;
  galleryTags?: Json;
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
 * Canvases repository (§10). Dual-dialect seam typed `any` (KTD-1); inputs and
 * the {@link Canvas} row shape stay strongly typed.
 */
export function canvasesRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.canvases : pgSchema.canvases;
  const versionsT = client.dialect === "sqlite" ? sqliteSchema.versions : pgSchema.versions;
  const usersT = client.dialect === "sqlite" ? sqliteSchema.users : pgSchema.users;

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
    eq(t.shared, true),
    eq(t.galleryListed, true),
    or(isNull(t.sharedExpiresAt), gt(t.sharedExpiresAt, now)),
    isNotNull(t.currentVersionId),
    isNull(t.passwordHash),
  ];

  return {
    async create(input: CreateCanvasInput): Promise<Canvas> {
      const now = Date.now();
      const rows = await db
        .insert(t)
        .values({
          id: uuidv7(),
          slug: input.slug,
          title: input.title ?? "",
          description: input.description ?? null,
          ownerId: input.ownerId,
          shared: false,
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

    async findById(id: string): Promise<Canvas | null> {
      const rows = await db.select().from(t).where(eq(t.id, id)).limit(1);
      return (rows[0] as Canvas | undefined) ?? null;
    },

    /**
     * Active-view list: a user's canvases newest-first, excluding soft-deleted
     * AND archived. Archived canvases live in their own view ({@link listArchivedByOwner}).
     */
    async listByOwner(ownerId: string): Promise<Canvas[]> {
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.ownerId, ownerId), notInArray(t.status, ["deleted", "archived"])))
        .orderBy(desc(t.createdAt))) as Canvas[];
    },

    /** Archive-view list: a user's archived canvases, newest-first. */
    async listArchivedByOwner(ownerId: string): Promise<Canvas[]> {
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.ownerId, ownerId), eq(t.status, "archived")))
        .orderBy(desc(t.createdAt))) as Canvas[];
    },

    async updateSettings(id: string, patch: CanvasSettingsPatch): Promise<Canvas> {
      const set: Record<string, unknown> = { updatedAt: Date.now() };
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.spaFallback !== undefined) set.spaFallback = patch.spaFallback;
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
      if (patch.galleryTags !== undefined) set.galleryTags = patch.galleryTags;
      if (patch.shared !== undefined) {
        set.shared = patch.shared;
        set.sharedAt = patch.shared ? Date.now() : null;
      }
      const rows = await db.update(t).set(set).where(eq(t.id, id)).returning();
      return rows[0] as Canvas;
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

    async regenerateSlug(id: string, newSlug: string): Promise<Canvas> {
      const rows = await db
        .update(t)
        .set({ slug: newSlug, updatedAt: Date.now() })
        .where(eq(t.id, id))
        .returning();
      return rows[0] as Canvas;
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
        .set({ status: "archived", updatedAt: Date.now() })
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

      const q = opts.q?.trim().toLowerCase();
      if (q) {
        // Portable case-insensitive substring match. LIKE metacharacters in the
        // user's text are escaped (ESCAPE '\') so a literal % / _ doesn't widen
        // the search — an accident-class concern, right-sized per the trust model.
        const pattern = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        filters.push(
          or(
            sql`lower(${t.title}) like ${pattern} escape '\\'`,
            sql`lower(${t.gallerySummary}) like ${pattern} escape '\\'`,
          ),
        );
      }

      if (opts.tag) {
        // JSON-array membership is the one genuinely dialect-divergent query.
        filters.push(
          client.dialect === "sqlite"
            ? sql`exists (select 1 from json_each(${t.galleryTags}) where value = ${opts.tag})`
            : sql`${t.galleryTags} @> ${JSON.stringify([opts.tag])}::jsonb`,
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
