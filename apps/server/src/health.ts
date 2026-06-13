import { sql } from "drizzle-orm";
import type { DbClient } from "./db/factory.js";

export interface HealthResult {
  status: "ok" | "degraded";
  db: "ok" | "error";
  version: string;
}

const VERSION = "0.0.0";

/** Cheap DB ping for `/healthz` (BUILD_BRIEF.md §6.11.6). */
export async function checkHealth(client: DbClient): Promise<HealthResult> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
    const db = client.db as any;
    // better-sqlite3 exposes .run(); pg/pglite expose .execute()
    if (client.dialect === "sqlite") db.run(sql`SELECT 1`);
    else await db.execute(sql`SELECT 1`);
    return { status: "ok", db: "ok", version: VERSION };
  } catch {
    return { status: "degraded", db: "error", version: VERSION };
  }
}
