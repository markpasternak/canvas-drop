import { type AllowedEmail, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

/**
 * Admin-managed individual sign-in allowlist (D14 supplement). Supplements the env
 * domain allowlist (CANVAS_DROP_ALLOWED_EMAIL_DOMAINS): an email listed here may sign
 * in even if its domain isn't allowed. Emails are stored + matched lowercased. Dual-
 * dialect seam typed `any` like the other repos; the {@link AllowedEmail} row stays typed.
 */
export function allowedEmailsRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.allowedEmails : pgSchema.allowedEmails;

  return {
    async list(): Promise<AllowedEmail[]> {
      return (await db.select().from(t).orderBy(t.createdAt)) as AllowedEmail[];
    },

    /** Add an email (idempotent on the unique index; stored lowercased). */
    async add(email: string, createdBy: string | null): Promise<AllowedEmail> {
      const normalized = email.trim().toLowerCase();
      const rows = await db
        .insert(t)
        .values({ id: uuidv7(), email: normalized, createdBy, createdAt: Date.now() })
        .onConflictDoUpdate({ target: t.email, set: { createdBy } })
        .returning();
      return rows[0] as AllowedEmail;
    },

    async remove(id: string): Promise<void> {
      await db.delete(t).where(eq(t.id, id));
    },

    /** Whether an email is individually allowlisted (case-insensitive). */
    async isAllowed(email: string): Promise<boolean> {
      const rows = (await db
        .select({ id: t.id })
        .from(t)
        .where(sql`lower(${t.email}) = ${email.trim().toLowerCase()}`)
        .limit(1)) as Array<{ id: string }>;
      return rows.length > 0;
    },
  };
}

export type AllowedEmailsRepository = ReturnType<typeof allowedEmailsRepository>;
