/**
 * Maintenance CLI (M10). The server binary doubles as an ops tool: `backup`,
 * `restore`, and `purge` run and exit instead of starting the HTTP server, so the
 * production Docker image needs no extra tooling — cron just runs the app image with a
 * subcommand (see docs/ops.md). All three load the same typed config as the server, so
 * they act on whichever DB + storage the instance is wired to.
 */
import { ConfigError, loadConfig } from "@canvas-drop/shared";
import { runLegacyGuestCutover } from "../access/legacy-guest-cutover.js";
import { purgeDeletedCanvases } from "../canvas/purge.js";
import type { DbClient } from "../db/factory.js";
import { makeDb } from "../db/factory.js";
import { runMigrations } from "../db/migrate.js";
import { aiUsageRepository } from "../db/repositories/ai-usage.js";
import { allowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { guestRepository } from "../db/repositories/guest.js";
import { invitationsRepository } from "../db/repositories/invitations.js";
import { screenshotsRepository } from "../db/repositories/screenshots.js";
import { usageEventsRepository } from "../db/repositories/usage-events.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import type { Logger } from "../log/logger.js";
import { createLogger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";
import { makeStorage } from "../storage/factory.js";
import { createBackup, restoreBackup } from "./backup.js";

/** Subcommands handled by the CLI (anything else → start the server). */
export const OPS_COMMANDS = ["backup", "restore", "purge", "guest-cutover"] as const;
type OpsCommand = (typeof OPS_COMMANDS)[number];

/** Retention window for the append-only metering tables (KTD-7) — stats need ~30d. */
const USAGE_EVENTS_RETENTION_DAYS = 90;

const firstNonFlag = (args: string[]): string | undefined => args.find((a) => !a.startsWith("-"));

/**
 * Full maintenance sweep, shared by the CLI and the dev `pnpm purge` script: reclaim
 * soft-deleted canvases' storage + version rows, then prune the metering tables. One
 * implementation so the two entry points can't drift.
 */
export async function runPurge(
  db: DbClient,
  storage: StorageDriver,
  log: Logger,
  opts: { olderThanDays: number; dryRun: boolean },
): Promise<void> {
  const { olderThanDays, dryRun } = opts;
  const scope = olderThanDays > 0 ? `soft-deleted ${olderThanDays}+ days ago` : "all soft-deleted";
  log.info({ olderThanDays, dryRun }, `purge sweep: ${scope}${dryRun ? " (dry run)" : ""}`);

  const summary = await purgeDeletedCanvases(
    {
      canvases: canvasesRepository(db),
      versions: versionsRepository(db),
      drafts: draftsRepository(db),
      screenshots: screenshotsRepository(db),
      storage,
      log,
    },
    { olderThanDays, dryRun },
  );
  log.info(summary, `purge: ${summary.canvasesPurged} canvas(es), ${summary.objectsDeleted} files`);
  if (summary.failed > 0) log.warn({ failed: summary.failed }, "some canvases were skipped; rerun");

  if (dryRun) return;
  const cutoff = Date.now() - USAGE_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const usage = await usageEventsRepository(db).pruneBefore(cutoff);
  const ai = await aiUsageRepository(db).pruneBefore(cutoff);
  log.info(
    { usage, ai, retentionDays: USAGE_EVENTS_RETENTION_DAYS },
    `pruned ${usage} usage_events + ${ai} ai_usage rows`,
  );
}

/** Parse `[days] [dry-run]` purge args. Shared with `scripts/purge-deleted.ts` so the dev
 *  `pnpm purge` and the prod `purge` subcommand parse identically (accepts `dry-run` /
 *  `dryrun` words and the `--dry-run` flag). */
export function parsePurgeArgs(rest: string[]): { olderThanDays: number; dryRun: boolean } {
  const words = rest.filter((a) => !a.startsWith("-"));
  const dryRun =
    rest.includes("--dry-run") || words.includes("dry-run") || words.includes("dryrun");
  const daysArg = words.find((w) => w !== "dry-run" && w !== "dryrun") ?? "0";
  const olderThanDays = Number(daysArg);
  if (!Number.isInteger(olderThanDays) || olderThanDays < 0) {
    throw new Error(`days must be a non-negative integer, got "${daysArg}"`);
  }
  return { olderThanDays, dryRun };
}

/**
 * If `argv` starts with a maintenance subcommand, run it and return `true` (the caller
 * should exit); otherwise return `false` so the server starts normally.
 */
export async function runOpsCli(argv: string[]): Promise<boolean> {
  const [cmd, ...rest] = argv;
  if (!OPS_COMMANDS.includes(cmd as OpsCommand)) return false;

  // Fail loud and readable on a bad env, matching the server's startup handler (index.ts) —
  // otherwise a mistyped var prints a raw stack trace instead of the one-line config message.
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const log = createLogger(config);
  const db = makeDb(config);
  const storage = makeStorage(config);

  try {
    if (cmd === "backup") {
      const dir = firstNonFlag(rest);
      if (!dir) throw new Error("usage: backup <output-dir>");
      await runMigrations(db); // a backup of an un-migrated DB should still produce a valid schema
      await createBackup({ client: db, storage, log }, dir);
    } else if (cmd === "restore") {
      const dir = firstNonFlag(rest);
      if (!dir) throw new Error("usage: restore <backup-dir> [--force]");
      await restoreBackup({ client: db, storage, log }, dir, { force: rest.includes("--force") });
    } else if (cmd === "purge") {
      // purge
      await runMigrations(db);
      await runPurge(db, storage, log, parsePurgeArgs(rest));
    } else {
      await runMigrations(db);
      const report = await runLegacyGuestCutover({
        config,
        users: usersRepository(db),
        allowedEmails: allowedEmailsRepository(db),
        invitations: invitationsRepository(db),
        canvases: canvasesRepository(db),
        guests: guestRepository(db),
        log,
      });
      log.info(report, "guest-cutover complete");
    }
  } finally {
    await db.close();
  }
  return true;
}
