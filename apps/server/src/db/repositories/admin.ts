import { type AccessRung, type Canvas, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, desc, eq, gte, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import type { DbClient } from "../factory.js";

/** Window for the "new in the last N days" growth stats (§6.10.6). */
const RECENT_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A canvas status the admin list can filter on (admin sees every status). */
export type AdminCanvasStatus = "active" | "disabled" | "archived" | "deleted";

/** Sort axes for the admin all-canvases list (member-parity, plan 006). */
export type AdminCanvasSort = "recent" | "created" | "title";

export interface ListAllCanvasesQuery {
  /** Narrow to one status; default returns all non-deleted canvases. */
  status?: AdminCanvasStatus;
  /** Substring match over title / slug / owner email (case-insensitive). */
  q?: string;
  /** Drill-down: restrict to a single owner by user id ("see what they have"). */
  owner?: string;
  /** Governance filter: narrow to one access rung (e.g. find every `public_link`). */
  access?: AccessRung;
  /** Sort axis; defaults to `recent` (last activity). */
  sort?: AdminCanvasSort;
  limit: number;
  offset: number;
}

/** Sort axes for the admin users list (plan 006). */
export type AdminUserSort = "active" | "created" | "name" | "canvases";

export interface ListUsersQuery {
  /** Substring match over name / email (case-insensitive). */
  q?: string;
  sort?: AdminUserSort;
  limit: number;
  offset: number;
}

/**
 * One row of the admin user-management table (plan 006). Identity + governance
 * facts only — `canvasCount` is an OBJECT fact (how much this person owns), never
 * a behavioral one. No view history, no sessions, no per-user activity (the
 * "governance without surveillance" line). `lastSeenAt` is a deliberate
 * admin-hygiene exception (spotting dormant admins).
 */
export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  isBlocked: boolean;
  /** Admin-granted publish-public capability (U10). */
  canPublishPublic: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  /** Non-deleted canvases this user owns (object fact). */
  canvasCount: number;
}

/** Platform overview aggregates (§6.10.6 — AI spend deferred to M9). */
export interface PlatformStats {
  canvasCountByStatus: Record<string, number>;
  userCount: number;
  /** Total stored file bytes across every canvas (deployed-version bytes show per-canvas). */
  totalFileBytes: number;
  /** Total recorded primitive ops across the platform (KV/file/etc), all time. */
  totalOps: number;
  /** Total recorded canvas page views across the platform, all time. */
  totalViews: number;
  /** Distinct org members who have viewed any canvas (engagement reach). */
  uniqueViewers: number;
  /** Total deploys across the platform (one per published version), all time. */
  totalDeploys: number;
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
  const versionsT = sqlite ? sqliteSchema.versions : pgSchema.versions;

  return {
    /**
     * Cross-owner canvas list with member-parity filter/search/sort + offset
     * pagination (plan 006 — replaces the prior keyset list so the admin table can
     * sort on arbitrary axes, which a single-column keyset cursor can't). The only
     * non-owner-scoped canvas read in the app (§12.0 #3); reachable solely behind
     * `requireAdmin`. Default excludes soft-deleted (the deleted-restore view passes
     * `status:"deleted"` explicitly). Joins `users` so the search can match an owner
     * email — an OBJECT fact (the canvas's owner), not audience behavior. Two-query
     * count posture at single-org scale, like the gallery / Your-canvases lists.
     */
    async listAllCanvasesFiltered(
      q: ListAllCanvasesQuery,
    ): Promise<{ items: Canvas[]; total: number }> {
      const filters: Array<SQL | undefined> = [];
      if (q.status) filters.push(eq(canvasesT.status, q.status));
      else filters.push(ne(canvasesT.status, "deleted"));
      if (q.owner) filters.push(eq(canvasesT.ownerId, q.owner));
      if (q.access) filters.push(eq(canvasesT.access, q.access));

      const search = q.q?.trim().toLowerCase();
      if (search) {
        // Portable, metacharacter-escaped LIKE over the admin-facing identifiers:
        // title, slug, and the owner's email (the canvas's owner — object fact).
        const pattern = `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        filters.push(
          or(
            sql`lower(${canvasesT.title}) like ${pattern} escape '\\'`,
            sql`lower(${canvasesT.slug}) like ${pattern} escape '\\'`,
            sql`lower(${usersT.email}) like ${pattern} escape '\\'`,
          ),
        );
      }
      const where = and(...filters);

      // Default is most-recent-activity (updatedAt); `created` and `title` mirror the
      // member list's axes. Every axis keeps an `id` tiebreak (uuidv7 monotonic) so
      // pages don't shuffle within an equal sort key.
      const orderBy =
        q.sort === "created"
          ? [desc(canvasesT.createdAt), desc(canvasesT.id)]
          : q.sort === "title"
            ? [sql`lower(${canvasesT.title}) asc`, desc(canvasesT.id)]
            : [desc(canvasesT.updatedAt), desc(canvasesT.id)];

      const rows = (await db
        .select({ canvas: canvasesT })
        .from(canvasesT)
        .leftJoin(usersT, eq(canvasesT.ownerId, usersT.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(q.limit)
        .offset(q.offset)) as Array<{ canvas: Canvas }>;

      // Each canvas has exactly one owner, so the left join never multiplies rows —
      // count(*) over the same join is the exact total.
      const totalRows = (await db
        .select({ value: sql<number>`count(*)` })
        .from(canvasesT)
        .leftJoin(usersT, eq(canvasesT.ownerId, usersT.id))
        .where(where)) as Array<{ value: number }>;

      return { items: rows.map((r) => r.canvas), total: Number(totalRows[0]?.value ?? 0) };
    },

    /**
     * Cross-owner user-management list (plan 006): identity + governance facts with
     * per-user owned-canvas counts, filter/search/sort + offset pagination. The
     * count LEFT JOINs canvases (excluding soft-deleted tombstones) so a user with
     * zero canvases still appears with count 0. `group by users.id` is valid on both
     * dialects (Postgres functional-dependency on the PK; SQLite is lenient). NO
     * behavioral data is read here — only object/identity facts (governance without
     * surveillance).
     */
    async listUsers(q: ListUsersQuery): Promise<{ items: AdminUserRow[]; total: number }> {
      const filters: Array<SQL | undefined> = [];
      const search = q.q?.trim().toLowerCase();
      if (search) {
        const pattern = `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        filters.push(
          or(
            sql`lower(${usersT.name}) like ${pattern} escape '\\'`,
            sql`lower(${usersT.email}) like ${pattern} escape '\\'`,
          ),
        );
      }
      const where = filters.length > 0 ? and(...filters) : undefined;

      const countExpr = sql<number>`count(${canvasesT.id})`;
      const orderBy =
        q.sort === "created"
          ? [desc(usersT.createdAt), desc(usersT.id)]
          : q.sort === "name"
            ? [sql`lower(${usersT.name}) asc`, desc(usersT.id)]
            : q.sort === "canvases"
              ? [sql`${countExpr} desc`, desc(usersT.id)]
              : // "active" (default): most-recently-seen first; never-seen rows last.
                [sql`${usersT.lastSeenAt} desc nulls last`, desc(usersT.id)];

      const rows = (await db
        .select({
          id: usersT.id,
          email: usersT.email,
          name: usersT.name,
          avatarUrl: usersT.avatarUrl,
          isAdmin: usersT.isAdmin,
          isBlocked: usersT.isBlocked,
          canPublishPublic: usersT.canPublishPublic,
          createdAt: usersT.createdAt,
          lastSeenAt: usersT.lastSeenAt,
          canvasCount: countExpr,
        })
        .from(usersT)
        .leftJoin(canvasesT, and(eq(canvasesT.ownerId, usersT.id), ne(canvasesT.status, "deleted")))
        .where(where)
        .groupBy(usersT.id)
        .orderBy(...orderBy)
        .limit(q.limit)
        .offset(q.offset)) as Array<AdminUserRow>;

      const totalRows = (await db
        .select({ value: sql<number>`count(*)` })
        .from(usersT)
        .where(where)) as Array<{ value: number }>;

      return {
        items: rows.map((r) => ({
          id: r.id,
          email: r.email,
          name: r.name,
          avatarUrl: r.avatarUrl,
          isAdmin: Boolean(r.isAdmin),
          isBlocked: Boolean(r.isBlocked),
          canPublishPublic: Boolean(r.canPublishPublic),
          createdAt: Number(r.createdAt),
          lastSeenAt: r.lastSeenAt === null ? null : Number(r.lastSeenAt),
          canvasCount: Number(r.canvasCount),
        })),
        total: Number(totalRows[0]?.value ?? 0),
      };
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
        viewRows,
        deployRows,
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
        db
          .select({
            total: sql<number>`count(*)`,
            unique: sql<number>`count(distinct ${usageT.userId})`,
          })
          .from(usageT)
          .where(eq(usageT.type, "view")),
        // One *ready* version row per deploy. Pending/failed builds never went
        // live, so they aren't deploys and must not inflate the count.
        db
          .select({ count: sql<number>`count(*)` })
          .from(versionsT)
          .where(eq(versionsT.status, "ready")),
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
        totalViews: Number((viewRows as Array<{ total: number }>)[0]?.total ?? 0),
        uniqueViewers: Number((viewRows as Array<{ unique: number }>)[0]?.unique ?? 0),
        totalDeploys: Number((deployRows as Array<{ count: number }>)[0]?.count ?? 0),
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
