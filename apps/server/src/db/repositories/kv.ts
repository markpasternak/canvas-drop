import { type Json, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, asc, eq, gt, gte, lt, sql } from "drizzle-orm";
import type { DbClient } from "../factory.js";

/** Thrown by `increment` when the existing value is present but not a number. */
export class KvNotNumericError extends Error {
  readonly code = "NOT_NUMERIC" as const;
  constructor() {
    super("KV value is not a number; cannot increment");
    this.name = "KvNotNumericError";
  }
}

export interface KvListResult {
  entries: Array<{ key: string; value: Json }>;
  /** Pass back as `cursor` to fetch the next page; null when exhausted. */
  nextCursor: string | null;
}

/**
 * KV repository (§6.4, plan 007 / M6). `scope` is `'shared'` (kv.*) or a userId
 * (kv.user.*) — always derived server-side by the route, never client-supplied.
 * Dual-dialect seam typed `any` (KTD-1).
 *
 * Atomic increment (KTD-3, R2): a single `INSERT … ON CONFLICT DO UPDATE` whose
 * SET expression reads the row's own current value — evaluated atomically per row
 * by the engine, so concurrent increments never lose updates. The numeric
 * expression is the one dialect-specific bit (SQLite text-json vs PG jsonb); no
 * cross-dialect transaction is needed.
 */
export function kvRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const isSqlite = client.dialect === "sqlite";
  const t = isSqlite ? sqliteSchema.kvEntries : pgSchema.kvEntries;

  return {
    async get(canvasId: string, scope: string, key: string): Promise<Json | null> {
      const rows = await db
        .select({ value: t.value })
        .from(t)
        .where(and(eq(t.canvasId, canvasId), eq(t.scope, scope), eq(t.key, key)))
        .limit(1);
      return (rows[0]?.value as Json | undefined) ?? null;
    },

    async set(
      canvasId: string,
      scope: string,
      key: string,
      value: Json,
      userId: string,
    ): Promise<void> {
      await db
        .insert(t)
        .values({ canvasId, scope, key, value, updatedBy: userId, updatedAt: Date.now() })
        .onConflictDoUpdate({
          target: [t.canvasId, t.scope, t.key],
          set: { value, updatedBy: userId, updatedAt: Date.now() },
        });
    },

    async delete(canvasId: string, scope: string, key: string): Promise<void> {
      await db.delete(t).where(and(eq(t.canvasId, canvasId), eq(t.scope, scope), eq(t.key, key)));
    },

    async list(
      canvasId: string,
      scope: string,
      opts: { prefix?: string; cursor?: string; limit?: number } = {},
    ): Promise<KvListResult> {
      const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
      const conds = [eq(t.canvasId, canvasId), eq(t.scope, scope)];
      // Prefix as a [prefix, prefix+￿) range — no LIKE escaping needed.
      if (opts.prefix) {
        conds.push(gte(t.key, opts.prefix), lt(t.key, `${opts.prefix}￿`));
      }
      if (opts.cursor) conds.push(gt(t.key, opts.cursor));
      const rows = (await db
        .select({ key: t.key, value: t.value })
        .from(t)
        .where(and(...conds))
        .orderBy(asc(t.key))
        .limit(limit + 1)) as Array<{ key: string; value: Json }>;
      const hasMore = rows.length > limit;
      const entries = hasMore ? rows.slice(0, limit) : rows;
      return { entries, nextCursor: hasMore ? (entries[entries.length - 1]?.key ?? null) : null };
    },

    async countKeys(canvasId: string, scope: string): Promise<number> {
      const rows = (await db
        .select({ count: sql<number>`count(*)` })
        .from(t)
        .where(and(eq(t.canvasId, canvasId), eq(t.scope, scope)))) as Array<{ count: number }>;
      return Number(rows[0]?.count ?? 0);
    },

    /**
     * Atomic increment. Missing key starts at 0 then applies `by`. A present-but-
     * non-numeric value throws {@link KvNotNumericError} (→ 409). Returns the new
     * total.
     */
    async increment(
      canvasId: string,
      scope: string,
      key: string,
      by: number,
      userId: string,
    ): Promise<number> {
      // Guard: reject a present non-numeric value (benign race on the error path
      // only; the numeric increment itself is atomic below).
      const existing = await this.get(canvasId, scope, key);
      if (existing !== null && typeof existing !== "number") throw new KvNotNumericError();

      const now = Date.now();
      // Dialect-specific atomic numeric expression on the row's own value. Use a
      // REAL cast on SQLite (NOT INTEGER) so fractional values aren't truncated —
      // keeps both dialects in lockstep for float counters (pg uses ::numeric).
      const nextExpr = isSqlite
        ? sql`CAST(${t.value} AS REAL) + ${by}`
        : sql`to_jsonb((${t.value}::text::numeric) + ${by})`;
      const rows = (await db
        .insert(t)
        .values({ canvasId, scope, key, value: by, updatedBy: userId, updatedAt: now })
        .onConflictDoUpdate({
          target: [t.canvasId, t.scope, t.key],
          set: { value: nextExpr, updatedBy: userId, updatedAt: now },
        })
        .returning({ value: t.value })) as Array<{ value: Json }>;
      return Number(rows[0]?.value ?? by);
    },
  };
}

export type KvRepository = ReturnType<typeof kvRepository>;
