import type { DbClient } from "./factory.js";
import { canvasesRepository } from "./repositories/canvases.js";

/**
 * Apply pending migrations for the active dialect (called at boot, U11), then repair
 * any canvas row still holding the empty publication-token default (deployment-
 * coordination plan, KTD1 / R6) — rows a pre-0043 backup restore or another writer left
 * behind. Idempotent: a fully minted database changes nothing.
 */
export async function runMigrations(client: DbClient): Promise<void> {
  await client.migrate();
  await canvasesRepository(client).mintMissingPublicationTokens();
}
