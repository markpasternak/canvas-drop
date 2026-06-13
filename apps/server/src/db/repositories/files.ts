import { type FileRow, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DbClient } from "../factory.js";

export interface NewFileInput {
  id: string;
  canvasId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  storageKey: string;
  uploadedBy: string;
}

/**
 * Files metadata repository (§6.5, plan 007 / M6). Rows only — bytes live in the
 * storage driver (orchestrated by {@link filesService}). Every query is scoped by
 * `canvasId` so a file id from one canvas is invisible to another (§12.0 #4).
 * Dual-dialect seam typed `any` (KTD-1).
 */
export function filesRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.files : pgSchema.files;

  return {
    async insert(input: NewFileInput): Promise<FileRow> {
      const rows = await db
        .insert(t)
        .values({ ...input, createdAt: Date.now() })
        .returning();
      return rows[0] as FileRow;
    },

    async list(canvasId: string): Promise<FileRow[]> {
      return (await db
        .select()
        .from(t)
        .where(eq(t.canvasId, canvasId))
        .orderBy(desc(t.createdAt))) as FileRow[];
    },

    async findById(canvasId: string, id: string): Promise<FileRow | null> {
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.canvasId, canvasId), eq(t.id, id)))
        .limit(1);
      return (rows[0] as FileRow | undefined) ?? null;
    },

    /** Delete the row if it belongs to the canvas; returns it (for blob cleanup) or null. */
    async remove(canvasId: string, id: string): Promise<FileRow | null> {
      const rows = (await db
        .delete(t)
        .where(and(eq(t.canvasId, canvasId), eq(t.id, id)))
        .returning()) as FileRow[];
      return rows[0] ?? null;
    },

    async totalBytes(canvasId: string): Promise<number> {
      const rows = (await db
        .select({ total: sql<number>`coalesce(sum(${t.sizeBytes}), 0)` })
        .from(t)
        .where(eq(t.canvasId, canvasId))) as Array<{ total: number }>;
      return Number(rows[0]?.total ?? 0);
    },
  };
}

export type FilesRepository = ReturnType<typeof filesRepository>;
