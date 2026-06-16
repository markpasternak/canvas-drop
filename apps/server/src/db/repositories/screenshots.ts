import { type ScreenshotJob, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, asc, eq, lte, or } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

/**
 * Screenshot-jobs repository (plan 004 / U2). Drives the `screenshot_jobs` table:
 * ONE row per canvas (unique `canvas_id`).
 *
 * Lifecycle:
 *   - `enqueue` (on publish) — coalesce upsert: pending with the new version_id,
 *     superseding any prior pending/terminal row for the canvas (only the latest
 *     version is worth capturing).
 *   - `claimNext` — atomically lease the oldest claimable row (pending, OR a
 *     `running` row whose lease expired — restart-safe), bumping `attempts`.
 *   - `markDone` / `markFailedOrRetry` — terminal or back-to-pending under the cap.
 *   - `reclaimStuck` — bulk-reclaim leases the worker dropped on restart/crash.
 *   - `sweepFailed` — reclaim permanently-failed rows past a TTL.
 *
 * Dual-dialect db seam typed `any` (KTD-1), matching the other repositories.
 */
export function screenshotsRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.screenshotJobs : pgSchema.screenshotJobs;

  return {
    /**
     * Coalesce upsert keyed on the unique `canvas_id`: insert a pending job or, if a
     * row already exists for this canvas, reset it to pending with the new version_id
     * and a cleared lease/attempts. This is how a republish supersedes a not-yet-run
     * capture — only the newest version's shot is worth taking.
     */
    async enqueue(canvasId: string, versionId: string): Promise<void> {
      const now = Date.now();
      await db
        .insert(t)
        .values({
          id: uuidv7(),
          canvasId,
          versionId,
          status: "pending",
          attempts: 0,
          leasedAt: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: t.canvasId,
          set: {
            versionId,
            status: "pending",
            attempts: 0,
            leasedAt: null,
            lastError: null,
            updatedAt: now,
          },
        });
    },

    /**
     * Atomically claim the oldest claimable job: a `pending` row, or a `running` row
     * whose lease is at/older than `staleBefore` (reclaim). Sets it `running`, stamps
     * the lease, and bumps `attempts`. Returns the claimed row, or null when nothing
     * is claimable or another worker won the race (the caller retries next tick).
     */
    async claimNext(now: number, staleBefore: number): Promise<ScreenshotJob | null> {
      const claimable = or(
        eq(t.status, "pending"),
        and(eq(t.status, "running"), lte(t.leasedAt, staleBefore)),
      );
      const candidates = (await db
        .select({ id: t.id, attempts: t.attempts })
        .from(t)
        .where(claimable)
        .orderBy(asc(t.createdAt))
        .limit(1)) as Array<{ id: string; attempts: number }>;
      const candidate = candidates[0];
      if (!candidate) return null;

      const rows = await db
        .update(t)
        .set({ status: "running", leasedAt: now, attempts: candidate.attempts + 1, updatedAt: now })
        .where(and(eq(t.id, candidate.id), claimable))
        .returning();
      return (rows[0] as ScreenshotJob | undefined) ?? null;
    },

    /** Terminal success — the renditions are stored. */
    async markDone(id: string): Promise<void> {
      await db
        .update(t)
        .set({ status: "done", leasedAt: null, lastError: null, updatedAt: Date.now() })
        .where(eq(t.id, id));
    },

    /**
     * Record a failed attempt: back to `pending` (cleared lease) while
     * `attempts < maxAttempts`, else terminal `failed` with the error recorded.
     * `attempts` was already bumped at claim time, so it reflects this attempt.
     */
    async markFailedOrRetry(id: string, error: string, maxAttempts: number): Promise<void> {
      const rows = (await db
        .select({ attempts: t.attempts })
        .from(t)
        .where(eq(t.id, id))
        .limit(1)) as Array<{ attempts: number }>;
      const attempts = rows[0]?.attempts ?? maxAttempts;
      const terminal = attempts >= maxAttempts;
      await db
        .update(t)
        .set({
          status: terminal ? "failed" : "pending",
          leasedAt: null,
          lastError: error.slice(0, 2000),
          updatedAt: Date.now(),
        })
        .where(eq(t.id, id));
    },

    /**
     * Bulk-reclaim `running` rows whose lease expired (worker died/restarted mid-job):
     * back to `pending` so a later tick re-claims. `claimNext` also reclaims inline;
     * this is the cheap periodic sweep run at the top of each tick.
     */
    async reclaimStuck(staleBefore: number): Promise<void> {
      await db
        .update(t)
        .set({ status: "pending", leasedAt: null, updatedAt: Date.now() })
        .where(and(eq(t.status, "running"), lte(t.leasedAt, staleBefore)));
    },

    /** Reclaim permanently-failed rows older than the cutoff (bounded retry of a
     *  canvas that keeps failing; the next publish re-enqueues a fresh attempt). */
    async sweepFailed(cutoff: number): Promise<void> {
      await db.delete(t).where(and(eq(t.status, "failed"), lte(t.updatedAt, cutoff)));
    },

    /** The job row for a canvas, or null (one row per canvas). */
    async findByCanvas(canvasId: string): Promise<ScreenshotJob | null> {
      const rows = await db.select().from(t).where(eq(t.canvasId, canvasId)).limit(1);
      return (rows[0] as ScreenshotJob | undefined) ?? null;
    },

    /** Hard-delete the job row for a canvas (purge cleanup, U10). */
    async deleteByCanvas(canvasId: string): Promise<void> {
      await db.delete(t).where(eq(t.canvasId, canvasId));
    },
  };
}

export type ScreenshotsRepository = ReturnType<typeof screenshotsRepository>;
