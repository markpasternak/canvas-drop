import {
  type DeploySource,
  type Json,
  type Manifest,
  pgSchema,
  sqliteSchema,
  type Version,
} from "@canvas-drop/shared/db";
import { and, desc, eq, inArray, isNotNull, max, notInArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

export interface CreatePendingVersionInput {
  canvasId: string;
  number: number;
  createdBy: string;
  source: DeploySource;
}

/**
 * Versions repository (§10, D11). Dual-dialect seam typed `any` (KTD-1).
 * A deploy inserts a `pending` row, writes files, then marks it `ready` and the
 * canvas pointer is swapped (the engine owns the transaction, U18).
 */
export function versionsRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.versions : pgSchema.versions;
  const canvasesT = client.dialect === "sqlite" ? sqliteSchema.canvases : pgSchema.canvases;

  return {
    /** Next per-canvas sequence number (1 for a fresh canvas). */
    async nextNumber(canvasId: string): Promise<number> {
      const rows = await db
        .select({ max: max(t.number) })
        .from(t)
        .where(eq(t.canvasId, canvasId));
      return ((rows[0]?.max as number | null) ?? 0) + 1;
    },

    async createPending(input: CreatePendingVersionInput): Promise<Version> {
      const rows = await db
        .insert(t)
        .values({
          id: uuidv7(),
          canvasId: input.canvasId,
          number: input.number,
          createdBy: input.createdBy,
          source: input.source,
          status: "pending",
          fileCount: 0,
          totalBytes: 0,
          manifest: null,
          createdAt: Date.now(),
        })
        .returning();
      return rows[0] as Version;
    },

    async markReady(
      id: string,
      data: { fileCount: number; totalBytes: number; manifest: Manifest },
    ): Promise<Version> {
      const rows = await db
        .update(t)
        .set({
          status: "ready",
          fileCount: data.fileCount,
          totalBytes: data.totalBytes,
          // biome-ignore lint/suspicious/noExplicitAny: Manifest is a Json subtype; cast at the dual-dialect seam (KTD-1)
          manifest: data.manifest as any as Json,
        })
        .where(eq(t.id, id))
        .returning();
      return rows[0] as Version;
    },

    async findById(id: string): Promise<Version | null> {
      const rows = await db.select().from(t).where(eq(t.id, id)).limit(1);
      return (rows[0] as Version | undefined) ?? null;
    },

    /**
     * Batch-fetch versions by id (list-view `lastDeploy` enrichment — map each
     * canvas's `currentVersionId` to its summary in one query, no N+1). Guards the
     * empty-input case: Drizzle's `in ()` errors on some dialects.
     */
    async findByIds(ids: string[]): Promise<Version[]> {
      if (ids.length === 0) return [];
      return (await db.select().from(t).where(inArray(t.id, ids))) as Version[];
    },

    /** A specific ready version by number (rollback target lookup). */
    async findReadyByNumber(canvasId: string, number: number): Promise<Version | null> {
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.canvasId, canvasId), eq(t.number, number), eq(t.status, "ready")))
        .limit(1);
      return (rows[0] as Version | undefined) ?? null;
    },

    /** Deploy history, newest first. */
    async listByCanvas(canvasId: string): Promise<Version[]> {
      return (await db
        .select()
        .from(t)
        .where(eq(t.canvasId, canvasId))
        .orderBy(desc(t.number))) as Version[];
    },

    /**
     * Prune ready version **rows** beyond the newest `keep`, never the live
     * current one. Returns the rows actually deleted so the caller knows which
     * versions are gone. Storage is NOT touched here: under content-addressed
     * blobs (M5), a version's bytes may be shared with surviving versions or the
     * draft, so blob reclamation is a separate per-canvas mark-sweep GC (KTD-4),
     * never a per-version prefix delete.
     *
     * The live current pointer is re-read ATOMICALLY inside the DELETE (a
     * correlated subquery on `canvases.current_version_id`), NOT from a snapshot —
     * so a concurrent rollback that just made an old version current never has it
     * pruned out from under it (prune-vs-rollback race). With the companion
     * `setCurrentVersionIfReady` guard, every interleaving is safe without a
     * cross-dialect transaction. `notInArray` over an `isNotNull`-filtered
     * subquery avoids NULL-poisoning when the canvas has no current version yet.
     */
    /**
     * Hard-delete every version row for a canvas (purge). The caller removes the
     * versions' storage objects first; this clears the rows so the canvas row
     * can then be deleted without tripping the `canvas_id` FK.
     */
    async deleteByCanvas(canvasId: string): Promise<void> {
      await db.delete(t).where(eq(t.canvasId, canvasId));
    },

    async pruneBeyond(canvasId: string, keep: number): Promise<Version[]> {
      const ready = (await db
        .select()
        .from(t)
        .where(and(eq(t.canvasId, canvasId), eq(t.status, "ready")))
        .orderBy(desc(t.number))) as Version[];
      const candidates = ready.slice(keep);
      if (candidates.length === 0) return [];
      const liveCurrent = db
        .select({ id: canvasesT.currentVersionId })
        .from(canvasesT)
        .where(and(eq(canvasesT.id, canvasId), isNotNull(canvasesT.currentVersionId)));
      const deleted = (await db
        .delete(t)
        .where(
          and(
            inArray(
              t.id,
              candidates.map((v) => v.id),
            ),
            notInArray(t.id, liveCurrent),
          ),
        )
        .returning()) as Version[];
      return deleted;
    },
  };
}

export type VersionsRepository = ReturnType<typeof versionsRepository>;
