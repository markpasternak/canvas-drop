/**
 * One-time backfill of the denormalized `search_text` column (plan 2026-06-19, KTD1).
 *
 * Thin CLI wrapper around the shared {@link backfillSearchText} core (also used by the
 * idempotent boot-time backfill in apps/server/src/index.ts), so a hand-run and an
 * auto-run share ONE implementation and can never diverge. Reuses the SAME
 * `computeSearchText()` the live write paths use, so backfilled and live-maintained
 * rows can never diverge.
 *
 * Run from the repo root against the target DB (resolved from `.env`):
 *   pnpm backfill:search-text          # only rows where search_text IS NULL
 *   pnpm backfill:search-text --all    # recompute ALL rows (e.g. after a normalize() change)
 *
 * Idempotent. Safe to re-run. Updates are applied in chunked transactions, so a
 * partial failure rolls back only the in-flight chunk, not the rows already done.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@canvas-drop/shared";
import { backfillSearchText } from "../src/db/backfill-search-text.js";
import { makeDb } from "../src/db/factory.js";
import { runMigrations } from "../src/db/migrate.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");
const ENV_FILE = join(REPO_ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

async function main() {
  const all = process.argv.includes("--all");
  const config = loadConfig();
  const client = makeDb(config);
  await runMigrations(client);

  const updated = await backfillSearchText(client, { all });

  process.stdout.write(
    `Backfilled search_text for ${updated} canvas row(s) (${all ? "all rows" : "NULL only"}, ` +
      `dialect=${client.dialect}).\n`,
  );
  await client.close();
}

main().catch((err) => {
  process.stderr.write(
    `backfill-search-text failed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
