/**
 * Dev/ops convenience wrapper for the maintenance purge sweep (BUILD_BRIEF §6.1 #14).
 * The actual work lives in `src/ops/cli.ts` (`runPurge`), shared with the production
 * `node dist/index.js purge` path so the two can never drift.
 *
 * Run (from the repo root):
 *   pnpm purge                 # reclaim EVERY soft-deleted canvas (default)
 *   pnpm purge 30              # only those soft-deleted 30+ days ago
 *   pnpm purge 30 dry-run      # report what 30 days would reclaim, delete nothing
 *
 * In production (the Docker image) use the server binary's subcommand instead:
 *   node --conditions=node-dist apps/server/dist/index.js purge [days] [dry-run]
 */
import { loadConfig } from "@canvas-drop/shared";
import { makeDb } from "../src/db/factory.js";
import { runMigrations } from "../src/db/migrate.js";
import { createLogger } from "../src/log/logger.js";
import { parsePurgeArgs, runPurge } from "../src/ops/cli.js";
import { makeStorage } from "../src/storage/factory.js";

async function main() {
  const { olderThanDays, dryRun } = parsePurgeArgs(process.argv.slice(2));
  const config = loadConfig();
  const log = createLogger(config);
  const db = makeDb(config);
  await runMigrations(db); // no-op if already migrated
  try {
    await runPurge(db, makeStorage(config), log, { olderThanDays, dryRun });
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  process.stderr.write(`purge failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
