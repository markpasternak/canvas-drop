import { type Canvas, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { DbClient } from "../factory.js";

/** Window for the "new in the last N days" growth stats (§6.10.6). */
const RECENT_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A canvas status the admin list can filter on (admin sees every status). */
export type AdminCanvasStatus = "active" | "disabled" | "archived" | "deleted";

export interface ListAllCanvasesQuery {
  /** Narrow to one status; default returns all non-deleted canvases. */
  status?: AdminCanvasStatus;
  /** Page size (caller clamps to a sane max). */
  limit: number;
  /** Keyset cursor: the `id` of the last row from the previous page (see below). */
  cursor?: string;
}

/** Platform overview aggregates (§6.10.6 — AI spend deferred to M9). */
export interface PlatformStats {
  canvasCountByStatus: Record<string, number>;
  userCount: number;
  /** Total stored file bytes across every canvas (deployed-version bytes show per-canvas). */
  totalFileBytes: number;
  /** Total recorded primitive ops across the platform (KV/file/etc), all time. */
  totalOps: number;
  /** Canvases created in the last {@link RECENT_WINDOW_DAYS} days (growth signal). */
  newCanvases: number;
  /** Users first seen in the last {@link RECENT_WINDOW_DAYS} days (growth signal). */
  newUsers: number;
  /** Window (days) the `new*` counts span — surfaced so the UI labels itself. */
  recentWindowDays: number;
  /** Oldest soft-deleted canvas's `deletedAt` (purge backlog age); null if none pending. */
  oldestDeletedAt: number | null;
  /** Most-active canvases by recorded primitive ops, newest usage first. */
  topCanvases: Array<{ canvasId: string; ops: number }>;
}

/**
 * Admin cross-owner read repository (§6.10, M7). The ONLY repository that reads
 * canvases across every owner — every other read path is owner-scoped (§12.0 #3).
 * Reachable only behind `requireAdmin` (server-resolved `isAdmin`). Status
 * transitions (disable/enable/restore) live on `canvasesRepository` next to
 * archive/unarchive (same guarded-transition pattern). Dual-dialect seam typed
 * `any` (KTD-1); aggregates `coalesce`+`Number()` for the pg-string / NULL-on-empty
 * trap.
 */
export function adminRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const sqlite = client.dialect === "sqlite";
  const canvasesT = sqlite ? sqliteSchema.canvases : pgSchema.canvases;
  const usersT = sqlite ? sqliteSchema.users : pgSchema.users;
  const filesT = sqlite ? sqliteSchema.files : pgSchema.files;
  const usageT = sqlite ? sqliteSchema.usageEvents : pgSchema.usageEvents;

  return {
    /**
     * Cross-owner canvas list, newest-first, keyset-paginated on the **UUIDv7 id**.
     * The id is unique AND time-ordered (its first 48 bits are the creation
     * timestamp), so ordering + the cursor on `id` alone is exact newest-first
     * with NO `created_at`-tie row loss — a `created_at`-only keyset drops rows
     * that share the boundary millisecond (code review). Default excludes
     * soft-deleted (the deleted-restore view passes `status:"deleted"` explicitly).
     */
    async listAllCanvases(q: ListAllCanvasesQuery): Promise<Canvas[]> {
      const filters = [];
      if (q.status) filters.push(eq(canvasesT.status, q.status));
      else filters.push(ne(canvasesT.status, "deleted"));
      if (q.cursor !== undefined) filters.push(lt(canvasesT.id, q.cursor));
      return (await db
        .select()
        .from(canvasesT)
        .where(and(...filters))
        .orderBy(desc(canvasesT.id))
        .limit(q.limit)) as Canvas[];
    },

    /**
     * Platform overview aggregates for the admin dashboard (§6.10.6). `now` is
     * injectable so the "new in the last N days" window is deterministic in tests.
     */
    async platformStats(topLimit: number, now: number = Date.now()): Promise<PlatformStats> {
      const recentCutoff = now - RECENT_WINDOW_DAYS * DAY_MS;
      const [
        statusRows,
        userRows,
        byteRows,
        opsRows,
        newCanvasRows,
        newUserRows,
        deletedRows,
        topRows,
      ] = await Promise.all([
        db
          .select({ status: canvasesT.status, count: sql<number>`count(*)` })
          .from(canvasesT)
          .groupBy(canvasesT.status),
        db.select({ count: sql<number>`count(*)` }).from(usersT),
        db.select({ total: sql<number>`coalesce(sum(${filesT.sizeBytes}), 0)` }).from(filesT),
        db.select({ count: sql<number>`count(*)` }).from(usageT),
        db
          .select({ count: sql<number>`count(*)` })
          .from(canvasesT)
          .where(gte(canvasesT.createdAt, recentCutoff)),
        db
          .select({ count: sql<number>`count(*)` })
          .from(usersT)
          .where(gte(usersT.createdAt, recentCutoff)),
        db
          .select({ oldest: sql<number | null>`min(${canvasesT.deletedAt})` })
          .from(canvasesT)
          .where(eq(canvasesT.status, "deleted")),
        db
          .select({ canvasId: usageT.canvasId, ops: sql<number>`count(*)` })
          .from(usageT)
          .groupBy(usageT.canvasId)
          .orderBy(desc(sql`count(*)`))
          .limit(topLimit),
      ]);
      const canvasCountByStatus: Record<string, number> = {};
      for (const r of statusRows as Array<{ status: string; count: number }>) {
        canvasCountByStatus[r.status] = Number(r.count);
      }
      const oldest = (deletedRows as Array<{ oldest: number | null }>)[0]?.oldest ?? null;
      return {
        canvasCountByStatus,
        userCount: Number((userRows as Array<{ count: number }>)[0]?.count ?? 0),
        totalFileBytes: Number((byteRows as Array<{ total: number }>)[0]?.total ?? 0),
        totalOps: Number((opsRows as Array<{ count: number }>)[0]?.count ?? 0),
        newCanvases: Number((newCanvasRows as Array<{ count: number }>)[0]?.count ?? 0),
        newUsers: Number((newUserRows as Array<{ count: number }>)[0]?.count ?? 0),
        recentWindowDays: RECENT_WINDOW_DAYS,
        oldestDeletedAt: oldest === null ? null : Number(oldest),
        topCanvases: (topRows as Array<{ canvasId: string; ops: number }>).map((r) => ({
          canvasId: r.canvasId,
          ops: Number(r.ops),
        })),
      };
    },

    /** Batched per-canvas op counts for the admin list's "usage" column (no N+1). */
    async usageCountByCanvas(canvasIds: readonly string[]): Promise<Map<string, number>> {
      if (canvasIds.length === 0) return new Map();
      const rows = (await db
        .select({ canvasId: usageT.canvasId, ops: sql<number>`count(*)` })
        .from(usageT)
        .where(inArray(usageT.canvasId, [...canvasIds]))
        .groupBy(usageT.canvasId)) as Array<{ canvasId: string; ops: number }>;
      return new Map(rows.map((r) => [r.canvasId, Number(r.ops)]));
    },
  };
}

export type AdminRepository = ReturnType<typeof adminRepository>;
