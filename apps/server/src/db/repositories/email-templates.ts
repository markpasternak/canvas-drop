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
 * "use the seeded default" (reset = delete the row). `seedDefaults` is idempotent at boot:
 * it inserts missing rows and safely migrates untouched rows that still match a known previous
 * seeded body. Admin-edited rows (`updated_by` set) are never clobbered.
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

    /** Idempotently seed defaults and migrate old untouched defaults to the latest body. */
    async seedDefaults(
      defaults: Record<string, TemplateBody>,
      previousDefaults: readonly Record<string, TemplateBody>[] = [],
    ): Promise<void> {
      const now = Date.now();
      const existingRows = (await db.select().from(T)) as EmailTemplate[];
      const existing = new Map<string, EmailTemplate>(existingRows.map((row) => [row.key, row]));
      const rowsToInsert: Array<{
        key: string;
        subject: string;
        bodyHtml: string;
        bodyText: string;
        updatedBy: null;
        updatedAt: number;
      }> = [];

      const sameBody = (
        row: Pick<EmailTemplate, "subject" | "bodyHtml" | "bodyText">,
        body: TemplateBody,
      ) =>
        row.subject === body.subject &&
        row.bodyHtml === body.bodyHtml &&
        row.bodyText === body.bodyText;

      for (const [key, body] of Object.entries(defaults)) {
        const row = existing.get(key);
        const values = {
          key,
          subject: body.subject,
          bodyHtml: body.bodyHtml,
          bodyText: body.bodyText,
          updatedBy: null,
          updatedAt: now,
        };
        if (!row) {
          rowsToInsert.push(values);
          continue;
        }
        const isUntouchedSeed = row.updatedBy == null;
        const matchesKnownPrevious = previousDefaults.some((known) => {
          const previous = known[key];
          return previous ? sameBody(row, previous) : false;
        });
        if (isUntouchedSeed && matchesKnownPrevious && !sameBody(row, body)) {
          await db
            .update(T)
            .set({
              subject: body.subject,
              bodyHtml: body.bodyHtml,
              bodyText: body.bodyText,
              updatedBy: null,
              updatedAt: now,
            })
            .where(eq(T.key, key));
        }
      }

      if (rowsToInsert.length > 0) {
        await db.insert(T).values(rowsToInsert).onConflictDoNothing();
      }
    },
  };
}

export type EmailTemplatesRepository = ReturnType<typeof emailTemplatesRepository>;
