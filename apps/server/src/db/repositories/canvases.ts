import {
  type Canvas,
  type CanvasStatus,
  type Json,
  pgSchema,
  sqliteSchema,
} from "@canvas-drop/shared/db";
import { and, desc, eq, exists, ne, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

export interface CreateCanvasInput {
  ownerId: string;
  slug: string;
  apiKeyHash: string;
  title?: string;
  description?: string | null;
}

/** Mutable settings (§6.3). Undefined fields are left unchanged. */
export interface CanvasSettingsPatch {
  title?: string;
  description?: string | null;
  shared?: boolean;
  sharedExpiresAt?: number | null;
  spaFallback?: boolean;
  galleryListed?: boolean;
  gallerySummary?: string | null;
  galleryTags?: Json;
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
          passwordVersion: 0,
          spaFallback: false,
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

    /** Canvases owned by a user, newest first, excluding soft-deleted. */
    async listByOwner(ownerId: string): Promise<Canvas[]> {
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.ownerId, ownerId), ne(t.status, "deleted")))
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
      if (patch.gallerySummary !== undefined) set.gallerySummary = patch.gallerySummary;
      if (patch.galleryTags !== undefined) set.galleryTags = patch.galleryTags;
      if (patch.shared !== undefined) {
        set.shared = patch.shared;
        set.sharedAt = patch.shared ? Date.now() : null;
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

    /** Find by API key hash (Bearer-key deploy API); active canvases only. */
    async findByApiKeyHash(apiKeyHash: string): Promise<Canvas | null> {
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.apiKeyHash, apiKeyHash), eq(t.status, "active")))
        .limit(1);
      return (rows[0] as Canvas | undefined) ?? null;
    },
  };
}

export type CanvasesRepository = ReturnType<typeof canvasesRepository>;
