/**
 * One-time backfill of the denormalized `search_text` column (plan 2026-06-19, KTD1).
 *
 * `search_text` was added as a nullable column (U1) and is maintained on every
 * subsequent write by the canvases repository (create / updateSettings /
 * regenerateSlug). Existing rows from before that change carry NULL and would be
 * invisible to `?q=` until next edited — this script populates them once, reusing
 * the SAME `computeSearchText()` the live write paths use, so backfilled and
 * live-maintained rows can never diverge.
 *
 * It is a TS script, NOT a SQL migration step: the composition needs `normalize()`
 * (accent-stripping is not portable across SQLite/Postgres) and flattening the
 * JSON `tags` array would be dialect-divergent in raw SQL.
 *
 * Run from the repo root against the target DB (resolved from `.env`):
 *   pnpm backfill:search-text          # only rows where search_text IS NULL
 *   pnpm backfill:search-text --all    # recompute ALL rows (e.g. after a normalize() change)
 *
 * Idempotent. Safe to re-run. Touches only `search_text` — no other column, and no
 * `updated_at` bump (the blob is derived, not a user-visible change).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeSearchText, loadConfig } from "@canvas-drop/shared";
import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { eq, isNull } from "drizzle-orm";
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

  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam (mirrors the repo).
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.canvases : pgSchema.canvases;

  const rows = (await db
    .select({
      id: t.id,
      title: t.title,
      description: t.description,
      tags: t.tags,
      slug: t.slug,
    })
    .from(t)
    .where(all ? undefined : isNull(t.searchText))) as Array<{
    id: string;
    title: string;
    description: string | null;
    tags: unknown;
    slug: string;
  }>;

  let updated = 0;
  for (const row of rows) {
    const searchText = computeSearchText({
      title: row.title,
      description: row.description,
      tags: Array.isArray(row.tags) ? (row.tags as string[]) : null,
      slug: row.slug,
    });
    await db.update(t).set({ searchText }).where(eq(t.id, row.id));
    updated += 1;
  }

  process.stdout.write(
    `Backfilled search_text for ${updated} canvas row(s) (${all ? "all rows" : "NULL only"}, ` +
      `dialect=${client.dialect}).\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `backfill-search-text failed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
