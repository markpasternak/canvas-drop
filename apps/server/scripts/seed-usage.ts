/**
 * Dev seed: synthesize usage so the admin overview's data-gated sections light up —
 * "Top canvases by usage" (ranked by recorded ops) and "AI usage" (by-user / by-canvas
 * spend). Run AFTER `pnpm seed:canvases`, against the local SQLite dev DB:
 *
 *   pnpm --filter @canvas-drop/server exec tsx scripts/seed-usage.ts
 *
 * Picks the first handful of canvases and records a decreasing number of usage
 * events (so they rank), plus a few ai_usage rows. Idempotent enough for a demo —
 * re-running just adds more events.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@canvas-drop/shared";
import { sqliteSchema } from "@canvas-drop/shared/db";
import { makeDb } from "../src/db/factory.js";
import { runMigrations } from "../src/db/migrate.js";
import { aiUsageRepository } from "../src/db/repositories/ai-usage.js";
import { usageEventsRepository } from "../src/db/repositories/usage-events.js";

const here = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(here, "../../..", ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

async function main() {
  const config = loadConfig();
  const db = makeDb(config);
  await runMigrations(db);
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam (sqlite in dev)
  const drizzle = db.db as any;
  const c = sqliteSchema.canvases;
  const rows = (await drizzle
    .select({ id: c.id, ownerId: c.ownerId, slug: c.slug })
    .from(c)
    .limit(6)) as Array<{ id: string; ownerId: string; slug: string }>;

  if (rows.length === 0) {
    process.stderr.write("No canvases found — run `pnpm seed:canvases` first.\n");
    process.exit(1);
  }

  const usage = usageEventsRepository(db);
  const ai = aiUsageRepository(db);
  let events = 0;

  for (let i = 0; i < rows.length; i++) {
    const cv = rows[i] as { id: string; ownerId: string; slug: string };
    const ops = (rows.length - i) * 8; // decreasing → canvases rank in the Top list
    for (let k = 0; k < ops; k++) {
      await usage.record({
        canvasId: cv.id,
        userId: cv.ownerId,
        type: k % 3 === 0 ? "view" : "kv_op",
      });
    }
    events += ops;
    // The first three also accrue AI spend so the "AI usage" section appears.
    if (i < 3) {
      await ai.record({
        canvasId: cv.id,
        userId: cv.ownerId,
        provider: "anthropic",
        model: "claude-haiku-4-5",
        inputTokens: 1200,
        outputTokens: 600,
        costUsd: (3 - i) * 0.42,
      });
    }
  }

  process.stdout.write(
    `Seeded ${events} usage events + 3 AI rows across ${rows.length} canvases.\n` +
      "Open /admin — 'Top canvases by usage' and 'AI usage' now render (collapsible).\n",
  );
}

main().catch((err) => {
  process.stderr.write(`seed-usage failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
