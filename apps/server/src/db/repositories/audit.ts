import { type Json, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, desc, eq, gte, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

export interface AuditRow {
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  meta?: Json;
  ip?: string | null;
}

/** A persisted audit-log row (what `recent` returns). */
export interface AuditLogRow {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  meta: Json | null;
  ip: string | null;
  createdAt: number;
}

export interface AuditQuery {
  actions: readonly string[];
  actor?: string;
  canvasId?: string;
  q?: string;
  since?: number;
  until?: number;
  limit: number;
  offset: number;
}
export interface AuditDisplayRow extends AuditLogRow {
  actorName: string | null;
  actorEmail: string | null;
  canvasTitle: string | null;
  canvasSlug: string | null;
}

/** Legacy canvas events omitted targetType. Interpret only these known actions. */
export const CANVAS_AUDIT_ACTIONS = [
  "canvas_create",
  "canvas_clone",
  "canvas_disable",
  "canvas_enable",
  "canvas_restore",
  "canvas_feature",
  "canvas_reassign_owner",
  "canvas_transfer",
  "canvas_delete",
  "canvas_purge",
  "canvas_purge_failed",
  "canvas_archive",
  "canvas_unarchive",
  "canvas_unpublish",
  "password_change",
  "share_change",
  "capabilities_update",
  "slug_regen",
  "key_regen",
  "settings_update",
  "rollback",
  "deploy",
  "connection_grant_attach",
  "connection_grant_detach",
  "pending_invitation_cancel",
] as const;

/**
 * Audit repository (§10, §6.11.1). Append-only by convention; Postgres
 * deployments may additionally REVOKE UPDATE/DELETE. Dual-dialect seam typed
 * `any` (KTD-1).
 */
export function auditRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.auditLog : pgSchema.auditLog;
  const users = client.dialect === "sqlite" ? sqliteSchema.users : pgSchema.users;
  const canvases = client.dialect === "sqlite" ? sqliteSchema.canvases : pgSchema.canvases;

  return {
    async listFiltered(query: AuditQuery): Promise<{ items: AuditDisplayRow[]; total: number }> {
      const isCanvas = or(
        eq(t.targetType, "canvas"),
        and(isNull(t.targetType), inArray(t.action, [...CANVAS_AUDIT_ACTIONS])),
      );
      const filters: Array<SQL | undefined> = [inArray(t.action, [...query.actions])];
      if (query.actor) {
        filters.push(
          or(eq(t.actorId, query.actor), sql`lower(${users.email}) = ${query.actor.toLowerCase()}`),
        );
      }
      if (query.canvasId) filters.push(and(isCanvas, eq(t.targetId, query.canvasId)));
      if (query.since !== undefined) filters.push(gte(t.createdAt, query.since));
      if (query.until !== undefined) filters.push(lt(t.createdAt, query.until));
      if (query.q) {
        const pattern = `%${query.q.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        filters.push(
          or(
            sql`lower(${t.action}) like ${pattern} escape '\\'`,
            sql`lower(${t.targetId}) like ${pattern} escape '\\'`,
            sql`lower(${users.name}) like ${pattern} escape '\\'`,
            sql`lower(${users.email}) like ${pattern} escape '\\'`,
            sql`lower(${canvases.title}) like ${pattern} escape '\\'`,
            sql`lower(${canvases.slug}) like ${pattern} escape '\\'`,
          ),
        );
      }
      const where = and(...filters);
      const rows = (await db
        .select({
          id: t.id,
          actorId: t.actorId,
          action: t.action,
          targetType: t.targetType,
          targetId: t.targetId,
          meta: t.meta,
          ip: t.ip,
          createdAt: t.createdAt,
          actorName: users.name,
          actorEmail: users.email,
          canvasTitle: canvases.title,
          canvasSlug: canvases.slug,
        })
        .from(t)
        .leftJoin(users, eq(users.id, t.actorId))
        .leftJoin(canvases, and(isCanvas, eq(canvases.id, t.targetId)))
        .where(where)
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(query.limit)
        .offset(query.offset)) as AuditDisplayRow[];
      const counts = (await db
        .select({ count: sql<number>`count(*)` })
        .from(t)
        .leftJoin(users, eq(users.id, t.actorId))
        .leftJoin(canvases, and(isCanvas, eq(canvases.id, t.targetId)))
        .where(where)) as Array<{ count: number }>;
      return { items: rows, total: Number(counts[0]?.count ?? 0) };
    },
    async append(row: AuditRow): Promise<void> {
      await db.insert(t).values({
        id: uuidv7(),
        actorId: row.actorId ?? null,
        action: row.action,
        targetType: row.targetType ?? null,
        targetId: row.targetId ?? null,
        meta: row.meta ?? null,
        ip: row.ip ?? null,
        createdAt: Date.now(),
      });
    },

    /** Most-recent-first, for the admin audit viewer (v1.1) and tests. */
    async recent(limit = 100): Promise<AuditLogRow[]> {
      return (await db.select().from(t).orderBy(desc(t.createdAt)).limit(limit)) as AuditLogRow[];
    },

    /**
     * Retention prune (KTD-7): hard-delete audit rows older than `cutoffMs`.
     * Audit rows carry actor IP (PII); the privacy policy promises security/audit
     * logs are kept for a limited period then discarded — this implements that.
     * Append-only by convention; the prune sweep is the one sanctioned delete.
     * Returns the number of rows removed.
     */
    async pruneBefore(cutoffMs: number): Promise<number> {
      const rows = (await db
        .delete(t)
        .where(lt(t.createdAt, cutoffMs))
        .returning({ id: t.id })) as Array<{ id: string }>;
      return rows.length;
    },
  };
}

export type AuditRepository = ReturnType<typeof auditRepository>;
