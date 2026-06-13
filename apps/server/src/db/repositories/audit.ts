import { type Json, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { desc } from "drizzle-orm";
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
    async recent(limit = 100) {
      return db.select().from(t).orderBy(desc(t.createdAt)).limit(limit);
    },
  };
}

export type AuditRepository = ReturnType<typeof auditRepository>;
