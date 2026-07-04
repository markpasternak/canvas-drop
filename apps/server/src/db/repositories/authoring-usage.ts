import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

/** One canvas authored via the `authoring` capability (plan 2026-07-04). */
export interface AuthoringUsageInput {
  /** The viewer who authored the canvas (its owner). */
  actorId: string;
  /** The canvas whose page the viewer was on when they authored. */
  sourceCanvasId: string;
  /** The new canvas. */
  authoredCanvasId: string;
}

/**
 * Authoring-usage repository (plan 2026-07-04). Append-only metering for the
 * authoring capability; `record` is awaited on the publish route AFTER a fully
 * successful publish (so a failed publish never burns quota). `countByActorSince`
 * backs the per-viewer daily window; `countByActor` the all-time total. A dedicated
 * table (over counting audit events) so the all-time total survives audit pruning.
 * Dual-dialect seam typed `any` (KTD-1).
 */
export function authoringUsageRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.authoringUsage : pgSchema.authoringUsage;

  async function countWhere(where: ReturnType<typeof and> | undefined): Promise<number> {
    const rows = (await db.select({ n: sql<number>`count(*)` }).from(t).where(where)) as Array<{
      n: number;
    }>;
    return Number(rows[0]?.n ?? 0);
  }

  return {
    async record(input: AuthoringUsageInput): Promise<void> {
      await db.insert(t).values({
        id: uuidv7(),
        actorId: input.actorId,
        sourceCanvasId: input.sourceCanvasId,
        authoredCanvasId: input.authoredCanvasId,
        createdAt: Date.now(),
      });
    },

    /** Count canvases a viewer authored at/after `sinceMs` — the per-viewer-daily window. */
    countByActorSince(actorId: string, sinceMs: number): Promise<number> {
      return countWhere(and(eq(t.actorId, actorId), gte(t.createdAt, sinceMs)));
    },

    /** Count all canvases a viewer has ever authored — the all-time total window. */
    countByActor(actorId: string): Promise<number> {
      return countWhere(eq(t.actorId, actorId));
    },

    /** The canvas ids a viewer authored, newest first (for the viewer-scoped `list`). */
    async authoredIdsByActor(actorId: string): Promise<string[]> {
      const rows = (await db
        .select({ id: t.authoredCanvasId })
        .from(t)
        .where(eq(t.actorId, actorId))
        .orderBy(desc(t.createdAt))) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    },

    /** Retention prune (mirrors ai_usage): delete rows older than the cutoff. Returns rows removed. */
    async pruneBefore(cutoffMs: number): Promise<number> {
      const rows = (await db
        .delete(t)
        .where(lt(t.createdAt, cutoffMs))
        .returning({ id: t.id })) as Array<{ id: string }>;
      return rows.length;
    },
  };
}

export type AuthoringUsageRepository = ReturnType<typeof authoringUsageRepository>;
