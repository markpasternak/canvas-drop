import { type Json, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

/** A primitive op type recorded for stats (D24). */
export type UsageType = "kv_op" | "file_op" | "view" | "deploy" | "rt_connect";

export interface UsageEventInput {
  canvasId: string;
  userId: string;
  type: UsageType;
  meta?: Json;
}

/**
 * Usage-events repository (§10, D24 / plan 007). Append-only metering substrate.
 * `record` is best-effort and is called fire-and-forget from the primitive routes
 * (a metering write must never fail the request — mirror the audit-log pattern).
 * Dual-dialect seam typed `any` (KTD-1).
 */
export function usageEventsRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.usageEvents : pgSchema.usageEvents;

  return {
    async record(input: UsageEventInput): Promise<void> {
      await db.insert(t).values({
        id: uuidv7(),
        canvasId: input.canvasId,
        userId: input.userId,
        type: input.type,
        meta: input.meta ?? null,
        createdAt: Date.now(),
      });
    },

    /**
     * Count events per type for a canvas at/after `sinceMs` (null = all time).
     * Returns a `{ [type]: count }` map; types with zero events are absent.
     */
    async countByType(canvasId: string, sinceMs: number | null): Promise<Record<string, number>> {
      const where =
        sinceMs === null
          ? eq(t.canvasId, canvasId)
          : and(eq(t.canvasId, canvasId), gte(t.createdAt, sinceMs));
      const rows = (await db
        .select({ type: t.type, count: sql<number>`count(*)` })
        .from(t)
        .where(where)
        .groupBy(t.type)) as Array<{ type: string; count: number }>;
      const out: Record<string, number> = {};
      for (const r of rows) out[r.type] = Number(r.count);
      return out;
    },

    /**
     * Record a "view" for (canvas, viewer) unless one already exists within the
     * session window. D24 defines a view as "the initial load during a session",
     * not every request: a refresh or return inside `windowMs` does not re-count,
     * and `windowMs` of inactivity starts a new view (30-min sliding window). The
     * caller serves the HTML document first and fires this off the response path,
     * so a rare concurrent double-load may over-count by one — acceptable on the
     * trusted-org, best-effort metering model. Returns true when a row was inserted.
     */
    async recordView(input: {
      canvasId: string;
      userId: string;
      windowMs: number;
      now: number;
    }): Promise<boolean> {
      const since = input.now - input.windowMs;
      const existing = (await db
        .select({ id: t.id })
        .from(t)
        .where(
          and(
            eq(t.canvasId, input.canvasId),
            eq(t.userId, input.userId),
            eq(t.type, "view"),
            gte(t.createdAt, since),
          ),
        )
        .limit(1)) as Array<{ id: string }>;
      if (existing.length > 0) return false;
      await db.insert(t).values({
        id: uuidv7(),
        canvasId: input.canvasId,
        userId: input.userId,
        type: "view",
        meta: null,
        createdAt: input.now,
      });
      return true;
    },

    /**
     * Owner view summary (D24): total views, unique viewers, last-viewed.
     * `count(*)`, `count(distinct …)`, and `max(…)` are all dialect-safe; counts
     * are coerced through `Number()` (pg returns them as strings) and `lastViewedAt`
     * is null when the canvas has no views.
     */
    async viewStats(
      canvasId: string,
    ): Promise<{ totalViews: number; uniqueViewers: number; lastViewedAt: number | null }> {
      const rows = (await db
        .select({
          totalViews: sql<number>`count(*)`,
          uniqueViewers: sql<number>`count(distinct ${t.userId})`,
          lastViewedAt: sql<number | null>`max(${t.createdAt})`,
        })
        .from(t)
        .where(and(eq(t.canvasId, canvasId), eq(t.type, "view")))) as Array<{
        totalViews: number;
        uniqueViewers: number;
        lastViewedAt: number | null;
      }>;
      const r = rows[0];
      const last = r?.lastViewedAt;
      return {
        totalViews: Number(r?.totalViews ?? 0),
        uniqueViewers: Number(r?.uniqueViewers ?? 0),
        lastViewedAt: last === null || last === undefined ? null : Number(last),
      };
    },

    /**
     * Dense per-UTC-day `view` counts over the window `[sinceMs, now]` for the
     * 30-day sparkline (D24). Bucketing is done in JS — not dialect-specific date
     * SQL — so the query stays dialect-neutral (the seam doc flags `date()` /
     * `date_trunc()` divergence). Returns one entry per day incl. zero-view days,
     * oldest first, so the sparkline x-axis is uniform.
     */
    async viewsByDay(
      canvasId: string,
      sinceMs: number,
      now: number,
    ): Promise<Array<{ dayMs: number; count: number }>> {
      const DAY = 24 * 60 * 60 * 1000;
      // Bucket on the DB side with integer arithmetic — `(created_at / DAY) * DAY`
      // floors each timestamp to its UTC day start. This stays dialect-neutral (no
      // date()/date_trunc() divergence) and returns at most ~31 rows regardless of
      // event volume, instead of transferring every raw timestamp into Node.
      //
      // DAY is inlined as a SQL literal (not a bound parameter): SQLite does
      // *floating-point* division when the divisor is bound, yielding fractional
      // buckets that neither group nor match the integer JS keys; an integer
      // literal forces integer division on both dialects (bigint/int truncates on
      // Postgres too). DAY is a fixed trusted constant, so inlining is safe.
      const dayLit = sql.raw(String(DAY));
      const dayMsExpr = sql<number>`(${t.createdAt} / ${dayLit}) * ${dayLit}`;
      const rows = (await db
        .select({ dayMs: dayMsExpr, count: sql<number>`count(*)` })
        .from(t)
        .where(and(eq(t.canvasId, canvasId), eq(t.type, "view"), gte(t.createdAt, sinceMs)))
        .groupBy(dayMsExpr)) as Array<{ dayMs: number; count: number }>;

      // Build the dense series of UTC day-start buckets from `sinceMs`'s day to `now`'s.
      const startDay = Math.floor(sinceMs / DAY) * DAY;
      const endDay = Math.floor(now / DAY) * DAY;
      const counts = new Map<number, number>();
      for (let d = startDay; d <= endDay; d += DAY) counts.set(d, 0);
      for (const row of rows) {
        const day = Number(row.dayMs);
        if (counts.has(day)) counts.set(day, (counts.get(day) ?? 0) + Number(row.count));
      }
      return [...counts.entries()].map(([dayMs, count]) => ({ dayMs, count }));
    },

    /** Retention prune (KTD-7): delete rows older than the cutoff. Returns rows removed. */
    async pruneBefore(cutoffMs: number): Promise<number> {
      const rows = (await db
        .delete(t)
        .where(lt(t.createdAt, cutoffMs))
        .returning({ id: t.id })) as Array<{ id: string }>;
      return rows.length;
    },
  };
}

export type UsageEventsRepository = ReturnType<typeof usageEventsRepository>;
