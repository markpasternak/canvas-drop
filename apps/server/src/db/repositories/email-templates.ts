import { type EmailTemplate, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { eq } from "drizzle-orm";
import type { DbClient } from "../factory.js";

/** The editable body of a template (no key/audit fields) — what an admin sets / a default has. */
export interface TemplateBody {
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

/**
 * Email-templates store (plan 003 phase 3). One row per template key; a missing row means
 * "use the seeded default" (reset = delete the row). `seedDefaults` is idempotent at boot —
 * it inserts a default only when no row exists, so an admin override is never clobbered.
 */
export function emailTemplatesRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const T = (client.dialect === "sqlite" ? sqliteSchema : pgSchema).emailTemplates;

  return {
    async list(): Promise<EmailTemplate[]> {
      return (await db.select().from(T).orderBy(T.key)) as EmailTemplate[];
    },

    async get(key: string): Promise<EmailTemplate | null> {
      const rows = (await db.select().from(T).where(eq(T.key, key)).limit(1)) as EmailTemplate[];
      return rows[0] ?? null;
    },

    /** Set (or replace) an admin override for a template. */
    async upsert(key: string, body: TemplateBody, updatedBy: string): Promise<void> {
      const values = {
        key,
        subject: body.subject,
        bodyHtml: body.bodyHtml,
        bodyText: body.bodyText,
        updatedBy,
        updatedAt: Date.now(),
      };
      await db
        .insert(T)
        .values(values)
        .onConflictDoUpdate({
          target: T.key,
          set: {
            subject: body.subject,
            bodyHtml: body.bodyHtml,
            bodyText: body.bodyText,
            updatedBy,
            updatedAt: values.updatedAt,
          },
        });
    },

    /** Reset a template to its seeded default (delete the override row). */
    async remove(key: string): Promise<void> {
      await db.delete(T).where(eq(T.key, key));
    },

    /** Idempotently seed the default body for each key when no row exists (boot). */
    async seedDefaults(defaults: Record<string, TemplateBody>): Promise<void> {
      const now = Date.now();
      const rows = Object.entries(defaults).map(([key, body]) => ({
        key,
        subject: body.subject,
        bodyHtml: body.bodyHtml,
        bodyText: body.bodyText,
        updatedBy: null,
        updatedAt: now,
      }));
      if (rows.length === 0) return;
      await db.insert(T).values(rows).onConflictDoNothing();
    },
  };
}

export type EmailTemplatesRepository = ReturnType<typeof emailTemplatesRepository>;
