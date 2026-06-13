import type { DbClient } from "./factory.js";

/** Apply pending migrations for the active dialect (called at boot, U11). */
export async function runMigrations(client: DbClient): Promise<void> {
  await client.migrate();
}
