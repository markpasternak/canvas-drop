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
    await client.ping();
    return { status: "ok", db: "ok", version: VERSION };
  } catch {
    return { status: "degraded", db: "error", version: VERSION };
  }
}
