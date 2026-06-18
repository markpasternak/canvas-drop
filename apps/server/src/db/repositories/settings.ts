import { type Json, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { eq } from "drizzle-orm";
import type { DbClient } from "../factory.js";

/**
 * Settings repository — small key/JSON store for the model allowlist, quota
 * defaults, and feature flags (§10). Dual-dialect seam typed `any` (KTD-1).
 */
export function settingsRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.settings : pgSchema.settings;

  return {
    async get(key: string): Promise<Json | undefined> {
      const rows = await db.select().from(t).where(eq(t.key, key)).limit(1);
      return (rows[0]?.value as Json | undefined) ?? undefined;
    },

    async set(key: string, value: Json): Promise<void> {
      // Single-statement atomic upsert — two concurrent writers (e.g. an admin
      // saving in two tabs) can't both observe an absent row and race to INSERT,
      // which would surface a unique-constraint 500. Matches the kv/guest pattern.
      await db.insert(t).values({ key, value }).onConflictDoUpdate({
        target: t.key,
        set: { value },
      });
    },

    /** Remove a stored override so the value falls back to env/default. */
    async delete(key: string): Promise<void> {
      await db.delete(t).where(eq(t.key, key));
    },
  };
}

export type SettingsRepository = ReturnType<typeof settingsRepository>;
