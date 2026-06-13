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
      const existing = await db.select().from(t).where(eq(t.key, key)).limit(1);
      if (existing[0]) {
        await db.update(t).set({ value }).where(eq(t.key, key));
      } else {
        await db.insert(t).values({ key, value });
      }
    },
  };
}

export type SettingsRepository = ReturnType<typeof settingsRepository>;
