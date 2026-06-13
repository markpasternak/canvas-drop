/**
 * Reclaim storage from soft-deleted canvases (BUILD_BRIEF §6.1 #14).
 *
 * Deleting a canvas in the dashboard is only a soft-delete (status + deletedAt).
 * This maintenance sweep hard-deletes the heavy, reclaimable data — each
 * canvas's deployed **files** (storage objects, the whole point) and its
 * **version rows** (file metadata) — while keeping the canvas row itself as a
 * soft-deleted tombstone. It reads the same typed config as the server, so it
 * acts on whichever DB + storage your environment is wired to.
 *
 * Run (from the repo root):
 *   pnpm purge                 # reclaim EVERY soft-deleted canvas (default)
 *   pnpm purge 30              # only those soft-deleted 30+ days ago
 *   pnpm purge 30 dry-run      # report what 30 days would reclaim, delete nothing
 *
 * Or scoped to the server workspace:
 *   pnpm --filter @canvas-drop/server run purge [days] [dry-run]
 *
 * Arguments are positional words (not --flags), so they forward cleanly through
 * pnpm without being swallowed as pnpm's own options. The days argument is the
 * retention window: 0 (the default) means everything, a positive integer keeps
 * anything deleted more recently than that. Reclaiming files is irreversible —
 * pass the `dry-run` word first if unsure.
 */
import { loadConfig } from "@canvas-drop/shared";
import { purgeDeletedCanvases } from "../src/canvas/purge.js";
import { makeDb } from "../src/db/factory.js";
import { runMigrations } from "../src/db/migrate.js";
import { canvasesRepository } from "../src/db/repositories/canvases.js";
import { versionsRepository } from "../src/db/repositories/versions.js";
import { createLogger } from "../src/log/logger.js";
import { makeStorage } from "../src/storage/factory.js";

function parseArgs(argv: string[]): { olderThanDays: number; dryRun: boolean } {
  const words = argv.filter((a) => !a.startsWith("-"));
  const dryRun = words.includes("dry-run") || words.includes("dryrun");
  const daysArg = words.find((w) => w !== "dry-run" && w !== "dryrun") ?? "0";
  const olderThanDays = Number(daysArg);
  if (!Number.isInteger(olderThanDays) || olderThanDays < 0) {
    throw new Error(`days must be a non-negative integer, got "${daysArg}"`);
  }
  return { olderThanDays, dryRun };
}

async function main() {
  const { olderThanDays, dryRun } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const log = createLogger(config);
  const db = makeDb(config);
  await runMigrations(db); // no-op if already migrated

  const scope =
    olderThanDays > 0 ? `soft-deleted ${olderThanDays}+ days ago` : "all soft-deleted canvases";
  log.info({ olderThanDays, dryRun }, `purge sweep: ${scope}${dryRun ? " (dry run)" : ""}`);

  try {
    const summary = await purgeDeletedCanvases(
      {
        canvases: canvasesRepository(db),
        versions: versionsRepository(db),
        storage: makeStorage(config),
        log,
      },
      { olderThanDays, dryRun },
    );
    log.info(
      summary,
      dryRun
        ? `dry run: ${summary.canvasesPurged} canvas(es) would be reclaimed (${summary.objectsDeleted} files, ${summary.versionsPurged} versions)`
        : `reclaimed ${summary.canvasesPurged} canvas(es): ${summary.objectsDeleted} files + ${summary.versionsPurged} versions deleted, rows kept as tombstones`,
    );
    if (summary.failed > 0) {
      log.warn({ failed: summary.failed }, "some canvases were skipped; rerun to retry them");
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  process.stderr.write(`purge failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
