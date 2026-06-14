import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

/** A single proxied AI call's metering record (§6.6.6, plan 009 / M9). */
export interface AiUsageInput {
  canvasId: string;
  userId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * AI-usage repository (§6.6.6 / D24, plan 009 / M9). Append-only metering for the
 * AI primitive; the single source of truth for AI tokens/cost/op-count. `record`
 * is awaited on the AI route (so quota windows reflect it), unlike the
 * fire-and-forget usage_events meter. Spend queries back the per-user-daily and
 * per-canvas-monthly quotas (windows are computed in ai/quota.ts). Dual-dialect
 * seam typed `any` (KTD-1).
 */
export function aiUsageRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.aiUsage : pgSchema.aiUsage;

  async function spendSince(
    column: typeof t.userId | typeof t.canvasId,
    id: string,
    sinceMs: number,
  ): Promise<number> {
    const rows = (await db
      .select({ total: sql<number>`coalesce(sum(${t.costUsd}), 0)` })
      .from(t)
      .where(and(eq(column, id), gte(t.createdAt, sinceMs)))) as Array<{ total: number }>;
    return Number(rows[0]?.total ?? 0);
  }

  /** Sum cost + count grouped by a dimension (user or canvas), top spenders first. */
  async function spendGroupedBy(
    column: typeof t.userId | typeof t.canvasId,
    limit: number,
  ): Promise<Array<{ id: string; costUsd: number; calls: number }>> {
    const rows = (await db
      .select({
        id: column,
        costUsd: sql<number>`coalesce(sum(${t.costUsd}), 0)`,
        calls: sql<number>`count(*)`,
      })
      .from(t)
      .groupBy(column)
      .orderBy(sql`sum(${t.costUsd}) desc`)
      .limit(limit)) as Array<{ id: string; costUsd: number; calls: number }>;
    return rows.map((r) => ({ id: r.id, costUsd: Number(r.costUsd), calls: Number(r.calls) }));
  }

  return {
    async record(input: AiUsageInput): Promise<void> {
      await db.insert(t).values({
        id: uuidv7(),
        canvasId: input.canvasId,
        userId: input.userId,
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costUsd: input.costUsd,
        createdAt: Date.now(),
      });
    },

    /** Sum cost (USD) for a user at/after `sinceMs` — the per-user-daily window. */
    userSpendSince(userId: string, sinceMs: number): Promise<number> {
      return spendSince(t.userId, userId, sinceMs);
    },

    /** Sum cost (USD) for a canvas at/after `sinceMs` — the per-canvas-monthly window. */
    canvasSpendSince(canvasId: string, sinceMs: number): Promise<number> {
      return spendSince(t.canvasId, canvasId, sinceMs);
    },

    /** Sum tokens + cost for a canvas over all time (owner usage tab, D24). */
    async canvasTotals(
      canvasId: string,
    ): Promise<{ inputTokens: number; outputTokens: number; costUsd: number; calls: number }> {
      const rows = (await db
        .select({
          inputTokens: sql<number>`coalesce(sum(${t.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${t.outputTokens}), 0)`,
          costUsd: sql<number>`coalesce(sum(${t.costUsd}), 0)`,
          calls: sql<number>`count(*)`,
        })
        .from(t)
        .where(eq(t.canvasId, canvasId))) as Array<{
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        calls: number;
      }>;
      const r = rows[0];
      return {
        inputTokens: Number(r?.inputTokens ?? 0),
        outputTokens: Number(r?.outputTokens ?? 0),
        costUsd: Number(r?.costUsd ?? 0),
        calls: Number(r?.calls ?? 0),
      };
    },

    /** Platform-wide AI totals (admin overview §6.10.6) — all canvases, all time. */
    async platformSpend(): Promise<{
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      calls: number;
    }> {
      const rows = (await db
        .select({
          costUsd: sql<number>`coalesce(sum(${t.costUsd}), 0)`,
          inputTokens: sql<number>`coalesce(sum(${t.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${t.outputTokens}), 0)`,
          calls: sql<number>`count(*)`,
        })
        .from(t)) as Array<{
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        calls: number;
      }>;
      const r = rows[0];
      return {
        costUsd: Number(r?.costUsd ?? 0),
        inputTokens: Number(r?.inputTokens ?? 0),
        outputTokens: Number(r?.outputTokens ?? 0),
        calls: Number(r?.calls ?? 0),
      };
    },

    /** Top spenders by canvas (admin §6.10.7). `id` is the raw canvas id — the route
     *  enriches it to slug/title + owner. Ordered by spend desc, capped at `limit`.
     *  (Spend-by-user was removed in plan 006 — admin governs canvas/owner spend, not
     *  per-member behavior.) */
    spendByCanvas(limit: number): Promise<Array<{ id: string; costUsd: number; calls: number }>> {
      return spendGroupedBy(t.canvasId, limit);
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

export type AiUsageRepository = ReturnType<typeof aiUsageRepository>;
