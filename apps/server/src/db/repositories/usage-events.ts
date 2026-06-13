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
