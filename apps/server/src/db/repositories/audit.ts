import { type Json, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { desc, lt } from "drizzle-orm";
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

/**
 * Audit repository (§10, §6.11.1). Append-only by convention; Postgres
 * deployments may additionally REVOKE UPDATE/DELETE. Dual-dialect seam typed
 * `any` (KTD-1).
 */
export function auditRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.auditLog : pgSchema.auditLog;

  return {
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
