/**
 * Dev data reset: wipe the local database AND all stored canvas files, so the next
 * `pnpm dev` (or `pnpm seed:canvases`) starts from an empty, freshly-migrated DB.
 *
 * Run from the repo root:
 *   pnpm reset:data
 *
 * Only touches the LOCAL dev stores resolved from your `.env`:
 *   - file-backed SQLite DB (CANVAS_DROP_SQLITE_PATH, default ./data/canvasdrop.db)
 *   - local storage dir (CANVAS_DROP_STORAGE_PATH, default ./data/storage)
 * It refuses to guess for Postgres / S3 — clear those yourself. Stop the dev server
 * first (`pnpm dev:stop`) so nothing holds the SQLite file open.
 */
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@canvas-drop/shared";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");
const ENV_FILE = join(REPO_ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

async function main() {
  const config = loadConfig();
  const cleared: string[] = [];

  if (config.db.driver === "sqlite" && config.db.path !== ":memory:") {
    // The -wal / -shm sidecars hold uncheckpointed writes; remove all three.
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = config.db.path + suffix;
      if (existsSync(file)) {
        await rm(file);
        cleared.push(file);
      }
    }
  } else {
    process.stdout.write(
      `DB driver is "${config.db.driver}" (not file-backed SQLite) — not deleting it. ` +
        "Drop/recreate that database yourself.\n",
    );
  }

  if (config.storage.driver === "local" && existsSync(config.storage.path)) {
    for (const entry of await readdir(config.storage.path)) {
      await rm(join(config.storage.path, entry), { recursive: true, force: true });
    }
    cleared.push(`${config.storage.path}/* (storage contents)`);
  } else if (config.storage.driver !== "local") {
    process.stdout.write(
      `Storage driver is "${config.storage.driver}" (not local) — not clearing it.\n`,
    );
  }

  process.stdout.write(
    cleared.length
      ? `\nCleared:\n${cleared.map((c) => `  - ${c}`).join("\n")}\n\n` +
          "The schema is recreated automatically on the next `pnpm dev` or `pnpm seed:canvases`.\n"
      : "\nNothing to clear — the local DB and storage were already empty.\n",
  );
}

main().catch((err) => {
  process.stderr.write(`reset failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
