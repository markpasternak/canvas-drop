import {
  type DeploySource,
  type Json,
  type Manifest,
  pgSchema,
  sqliteSchema,
  type Version,
} from "@canvas-drop/shared/db";
import { and, desc, eq, inArray, isNotNull, lt, max, notInArray } from "drizzle-orm";
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
      // Assert exactly one row updated. A finalize whose canvas (and its version
      // rows) was purged between begin and commit would otherwise silently mark a
      // gone version ready; here it fails cleanly so the upload service can abort
      // before swapping the live pointer (plan 003, purge-vs-staged-finalize guard).
      if (rows.length !== 1) {
        throw new Error(`markReady expected to update 1 version row, updated ${rows.length}`);
      }
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
     * Hard-delete every version row for a canvas (purge). The caller removes the
     * versions' storage objects first; this clears the rows so the canvas row
     * can then be deleted without tripping the `canvas_id` FK.
     */
    async deleteByCanvas(canvasId: string): Promise<void> {
      await db.delete(t).where(eq(t.canvasId, canvasId));
    },

    /**
     * Prune ready version **rows** beyond the newest `keep`, never the live
     * current one. Returns the rows actually deleted so the caller knows which
     * versions are gone. Storage is NOT touched here: under content-addressed
     * blobs (M5), a version's bytes may be shared with surviving versions or the
     * draft, so blob reclamation is a separate per-canvas mark-sweep GC (KTD-4),
     * never a per-version prefix delete.
     *
     * The candidate set is collected in a prior SELECT (a snapshot); the
     * live-current exclusion is re-evaluated ATOMICALLY inside the DELETE as a
     * correlated subquery on `canvases.current_version_id`, so a concurrent
     * rollback that just made an old version current never has it pruned out from
     * under it (prune-vs-rollback race). With the companion
     * `setCurrentVersionIfReady` guard, every interleaving is safe without a
     * cross-dialect transaction. `notInArray` over an `isNotNull`-filtered
     * subquery avoids NULL-poisoning when the canvas has no current version yet.
     */
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

    /**
     * Delete a single still-`pending` version row by id. Status-guarded, so it can
     * never remove a `ready` (let alone the live current) version even if misused.
     * Used to clean up the pending row a FAILED deploy left behind, so abandoned
     * attempts neither accumulate nor permanently burn a version number.
     */
    async deletePending(id: string): Promise<void> {
      await db.delete(t).where(and(eq(t.id, id), eq(t.status, "pending")));
    },

    /**
     * Sweep a canvas's `pending` version rows older than `before` (epoch ms) — the
     * safety net for abandoned/failed deploys that never reached `markReady`
     * (`pruneBeyond` only collects `ready` rows, so pending rows would otherwise
     * linger forever). The age cutoff keeps any in-flight deploy/finalize — which
     * commits within a single request — untouched. A pending row carries a NULL
     * manifest, so this references no blobs: a pure row cleanup. Returns the count
     * removed.
     */
    async deletePendingBefore(canvasId: string, before: number): Promise<number> {
      const deleted = (await db
        .delete(t)
        .where(and(eq(t.canvasId, canvasId), eq(t.status, "pending"), lt(t.createdAt, before)))
        .returning()) as Version[];
      return deleted.length;
    },
  };
}

export type VersionsRepository = ReturnType<typeof versionsRepository>;
