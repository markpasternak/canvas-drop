import {
  type DeploySource,
  type Json,
  type Manifest,
  pgSchema,
  sqliteSchema,
  type Version,
} from "@canvas-drop/shared/db";
import { and, desc, eq, inArray, max } from "drizzle-orm";
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
     * Ready versions to prune (keep the newest `keep`, never the current one).
     * Returns the dropped rows so the caller can delete their storage objects,
     * then deletes the rows.
     */
    async pruneBeyond(
      canvasId: string,
      keep: number,
      currentVersionId: string | null,
    ): Promise<Version[]> {
      const ready = (await db
        .select()
        .from(t)
        .where(and(eq(t.canvasId, canvasId), eq(t.status, "ready")))
        .orderBy(desc(t.number))) as Version[];
      const drop = ready.slice(keep).filter((v) => v.id !== currentVersionId);
      if (drop.length > 0) {
        await db.delete(t).where(
          inArray(
            t.id,
            drop.map((v) => v.id),
          ),
        );
      }
      return drop;
    },
  };
}

export type VersionsRepository = ReturnType<typeof versionsRepository>;
