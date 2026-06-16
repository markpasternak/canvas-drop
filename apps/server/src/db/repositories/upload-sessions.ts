import {
  type Json,
  type Manifest,
  pgSchema,
  sqliteSchema,
  type UploadSession,
} from "@canvas-drop/shared/db";
import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

export interface CreateUploadSessionInput {
  canvasId: string;
  ownerId: string;
  handleHash: string;
  manifest: Manifest;
  stagedHashes: string[];
  expiresAt: number;
}

/**
 * Upload-sessions repository (plan 003). The staging side of the two-channel
 * upload flow. Dual-dialect seam typed `any` (KTD-1).
 *
 * Lifecycle: `create` (at begin, with the full target manifest) → `setStaged`
 * (per blob landed) → `claimForFinalize`/`markConsumed`/`clearFinalizing`
 * (idempotent single-use finalize). `listActiveByCanvas` feeds the blob-GC live
 * set (U7); `deleteExpired` reclaims abandoned sessions.
 */
export function uploadSessionsRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.uploadSessions : pgSchema.uploadSessions;

  return {
    async create(input: CreateUploadSessionInput): Promise<UploadSession> {
      const rows = await db
        .insert(t)
        .values({
          id: uuidv7(),
          canvasId: input.canvasId,
          ownerId: input.ownerId,
          handleHash: input.handleHash,
          // biome-ignore lint/suspicious/noExplicitAny: Manifest is a Json subtype; cast at the dual-dialect seam (KTD-1)
          manifest: input.manifest as any as Json,
          // biome-ignore lint/suspicious/noExplicitAny: string[] is a Json subtype; cast at the dual-dialect seam (KTD-1)
          stagedHashes: input.stagedHashes as any as Json,
          expiresAt: input.expiresAt,
          finalizingAt: null,
          consumedAt: null,
          createdAt: Date.now(),
        })
        .returning();
      return rows[0] as UploadSession;
    },

    async findByHandleHash(handleHash: string): Promise<UploadSession | null> {
      const rows = await db.select().from(t).where(eq(t.handleHash, handleHash)).limit(1);
      return (rows[0] as UploadSession | undefined) ?? null;
    },

    /** Replace the staged-hash set (the subset of manifest hashes physically written). */
    async setStaged(id: string, stagedHashes: string[]): Promise<void> {
      await db
        .update(t)
        // biome-ignore lint/suspicious/noExplicitAny: string[] is a Json subtype; cast at the dual-dialect seam (KTD-1)
        .set({ stagedHashes: stagedHashes as any as Json })
        .where(eq(t.id, id));
    },

    /**
     * Atomically claim a session for finalize: set `finalizing_at` only when the
     * session is not yet consumed AND not already being finalized by a live
     * attempt (`finalizing_at` null or older than the lease). Returns the claimed
     * row or null when another live finalize holds it or it's already consumed —
     * the caller re-reads to distinguish "in progress" from "already finalized".
     * The lease lets a legitimate retry resume after a crashed/transient attempt.
     */
    async claimForFinalize(handleHash: string, staleBefore: number): Promise<UploadSession | null> {
      const rows = await db
        .update(t)
        .set({ finalizingAt: Date.now() })
        .where(
          and(
            eq(t.handleHash, handleHash),
            isNull(t.consumedAt),
            or(isNull(t.finalizingAt), lte(t.finalizingAt, staleBefore)),
          ),
        )
        .returning();
      return (rows[0] as UploadSession | undefined) ?? null;
    },

    /** Terminal: mark a session consumed after a successful pointer swap. */
    async markConsumed(id: string): Promise<void> {
      await db.update(t).set({ consumedAt: Date.now() }).where(eq(t.id, id));
    },

    /** Release the in-progress lease so a legitimate retry can re-claim (transient failure). */
    async clearFinalizing(id: string): Promise<void> {
      await db.update(t).set({ finalizingAt: null }).where(eq(t.id, id));
    },

    /**
     * Active (not consumed, not expired) sessions for a canvas — the blob-GC live
     * set unions these sessions' recorded manifests so a pending finalize's blobs
     * are never swept (U7).
     */
    async listActiveByCanvas(canvasId: string, now: number): Promise<UploadSession[]> {
      return (await db
        .select()
        .from(t)
        .where(and(eq(t.canvasId, canvasId), isNull(t.consumedAt), gt(t.expiresAt, now)))) as UploadSession[];
    },

    /** Reclaim sessions past their expiry (abandoned or long-since consumed). */
    async deleteExpired(cutoff: number): Promise<void> {
      await db.delete(t).where(lte(t.expiresAt, cutoff));
    },

    /** Hard-delete every session row for a canvas (purge, before the canvas FK clears). */
    async deleteByCanvas(canvasId: string): Promise<void> {
      await db.delete(t).where(eq(t.canvasId, canvasId));
    },
  };
}

export type UploadSessionsRepository = ReturnType<typeof uploadSessionsRepository>;
