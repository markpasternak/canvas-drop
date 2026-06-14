/**
 * Dev seed: deploy the primitives showcase (examples/showcase/) as a live canvas.
 *
 * Creates/updates a canvas at slug `showcase`, owned by your dev user, with the
 * backend + all five capabilities enabled, then deploys the example folder to it.
 * Idempotent — re-run after editing the example to redeploy the latest files.
 *
 * Run (from the repo root, with the dev DB already migrated by `pnpm dev`):
 *   pnpm seed:showcase
 *
 * AI is OFF until you set CANVAS_DROP_AI_API_KEY in .env (server-side only); the
 * showcase degrades gracefully when it isn't set.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@canvas-drop/shared";
import { generateApiKey, hashApiKey } from "../src/canvas/api-key.js";
import { canvasUrl } from "../src/canvas/url.js";
import { makeDb } from "../src/db/factory.js";
import { runMigrations } from "../src/db/migrate.js";
import { canvasesRepository } from "../src/db/repositories/canvases.js";
import { draftsRepository } from "../src/db/repositories/drafts.js";
import { usersRepository } from "../src/db/repositories/users.js";
import { versionsRepository } from "../src/db/repositories/versions.js";
import { deployEngine } from "../src/deploy/engine.js";
import type { DeployEntry } from "../src/deploy/ingest.js";
import { createLogger } from "../src/log/logger.js";
import { makeStorage } from "../src/storage/factory.js";

const SLUG = "showcase";
// Files in examples/showcase/ that are docs, not part of the deployed app.
const EXCLUDE = new Set(["README.md"]);

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");
const SHOWCASE_DIR = join(REPO_ROOT, "examples/showcase");

// Load the repo-root .env so we use the same DB/storage/AI config as `pnpm dev`,
// regardless of the cwd this script is launched from.
const ENV_FILE = join(REPO_ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

/** Read the example folder into canvas-relative DeployEntry[] (forward-slash paths). */
async function readShowcase(dir: string): Promise<DeployEntry[]> {
  const entries: DeployEntry[] = [];
  async function walk(current: string): Promise<void> {
    for (const dirent of await readdir(current, { withFileTypes: true })) {
      const abs = join(current, dirent.name);
      if (dirent.isDirectory()) {
        await walk(abs);
        continue;
      }
      const rel = relative(dir, abs).split(sep).join(posix.sep);
      if (EXCLUDE.has(rel)) continue;
      entries.push({ path: rel, bytes: new Uint8Array(await readFile(abs)) });
    }
  }
  await walk(dir);
  return entries;
}

async function main() {
  const config = loadConfig();
  const log = createLogger(config);
  const db = makeDb(config);
  await runMigrations(db); // no-op if the dev server already migrated

  const users = usersRepository(db);
  const canvases = canvasesRepository(db);
  const versions = versionsRepository(db);
  const drafts = draftsRepository(db);
  const storage = makeStorage(config);
  const engine = deployEngine({ config, canvases, versions, drafts, storage, log });

  // Own the canvas as YOUR dev user, so you can manage + edit it in the dashboard.
  // The providerSub mirrors devStrategy (`dev:${email}`) so browsing == owning.
  const { email, name } = config.auth.dev;
  const owner = await users.upsert({
    providerSub: `dev:${email}`,
    email,
    name,
    isAdmin: true,
  });

  let canvas = await canvases.findBySlug(SLUG);
  if (!canvas) {
    canvas = await canvases.create({
      ownerId: owner.id,
      slug: SLUG,
      apiKeyHash: hashApiKey(generateApiKey()),
      title: "Primitives showcase",
    });
  }

  // Backend + every primitive on, so the whole page works end-to-end.
  await canvases.updateCapabilities(canvas.id, {
    backendEnabled: true,
    kv: true,
    files: true,
    ai: true,
    realtime: true,
  });

  const files = await readShowcase(SHOWCASE_DIR);
  await engine.deploy(canvas, "folder", files, owner.id);

  const url = canvasUrl(config, SLUG);
  // NOTE: don't close the DB here. `engine.deploy` dispatches a fire-and-forget
  // blob-GC/prune after it resolves; closing now would race it ("database
  // connection is not open"). The handle is released on process exit; this is a
  // one-shot script, so letting the event loop drain the prune is correct.

  const aiOn = Boolean(config.ai.apiKey);
  process.stdout.write(
    [
      "",
      `Showcase deployed (${files.length} files) → ${url}`,
      "",
      "  Backend + KV + files + AI + realtime are enabled on this canvas.",
      aiOn
        ? "  AI: provider key detected — streaming chat is live."
        : "  AI: no CANVAS_DROP_AI_API_KEY set — the AI section shows a graceful 'off' card.",
      "",
      "  Re-run `pnpm seed:showcase` after editing examples/showcase/ to redeploy.",
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
