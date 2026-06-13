import {
  type Draft,
  type Json,
  type Manifest,
  pgSchema,
  sqliteSchema,
} from "@canvas-drop/shared/db";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

/**
 * Drafts repository (M5, R10–R15). Exactly one mutable draft per canvas (unique
 * `canvas_id`): the working set the in-browser editor mutates. A draft is a
 * manifest over content-addressed blobs — editing writes blobs + updates the
 * manifest, it never creates a version. Publish snapshots the manifest into a new
 * version (the draft service owns that). Dual-dialect seam typed `any` (KTD-1).
 */
export function draftsRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.drafts : pgSchema.drafts;

  return {
    async getByCanvas(canvasId: string): Promise<Draft | null> {
      const rows = await db.select().from(t).where(eq(t.canvasId, canvasId)).limit(1);
      return (rows[0] as Draft | undefined) ?? null;
    },

    /** Create the canvas's draft. Caller ensures one doesn't already exist. */
    async create(input: {
      canvasId: string;
      manifest: Manifest;
      baseVersionId: string | null;
    }): Promise<Draft> {
      const now = Date.now();
      const rows = await db
        .insert(t)
        .values({
          id: uuidv7(),
          canvasId: input.canvasId,
          // biome-ignore lint/suspicious/noExplicitAny: Manifest is a Json subtype; cast at the seam (KTD-1)
          manifest: input.manifest as any as Json,
          baseVersionId: input.baseVersionId,
          stale: false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return rows[0] as Draft;
    },

    /** Replace the draft's manifest; bumps updatedAt and clears the stale flag. */
    async setManifest(canvasId: string, manifest: Manifest): Promise<Draft> {
      const rows = await db
        .update(t)
        .set({
          // biome-ignore lint/suspicious/noExplicitAny: Manifest is a Json subtype; cast at the seam (KTD-1)
          manifest: manifest as any as Json,
          stale: false,
          updatedAt: Date.now(),
        })
        .where(eq(t.canvasId, canvasId))
        .returning();
      return rows[0] as Draft;
    },

    /**
     * Reset the draft to a base version's manifest (restore-to-draft, R14) — also
     * records which version it derives from and clears stale.
     */
    async resetToBase(
      canvasId: string,
      manifest: Manifest,
      baseVersionId: string | null,
    ): Promise<Draft> {
      const rows = await db
        .update(t)
        .set({
          // biome-ignore lint/suspicious/noExplicitAny: Manifest is a Json subtype; cast at the seam (KTD-1)
          manifest: manifest as any as Json,
          baseVersionId,
          stale: false,
          updatedAt: Date.now(),
        })
        .where(eq(t.canvasId, canvasId))
        .returning();
      return rows[0] as Draft;
    },

    /** Flag the draft stale: a direct publish landed under it (R15/F3). No manifest change. */
    async markStale(canvasId: string): Promise<void> {
      await db.update(t).set({ stale: true }).where(eq(t.canvasId, canvasId));
    },

    /** Remove the canvas's draft (purge path). */
    async deleteByCanvas(canvasId: string): Promise<void> {
      await db.delete(t).where(eq(t.canvasId, canvasId));
    },
  };
}

export type DraftsRepository = ReturnType<typeof draftsRepository>;
