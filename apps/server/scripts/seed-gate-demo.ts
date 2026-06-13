/**
 * Dev-only seed for manually testing the canvas password gate in a browser.
 *
 * The gate only ever prompts a NON-owner, NON-admin member viewing a SHARED +
 * password-protected canvas (owners and admins always bypass it — §12.0). In
 * default `dev` auth mode you're the owner + admin of everything, so you can't
 * normally see it. This creates a SECOND user and a shared, password-protected
 * canvas they own (with a deployed index.html), so your dev user can hit the gate
 * as a non-owner.
 *
 * Run:
 *   pnpm --filter @canvas-drop/server exec tsx scripts/seed-gate-demo.ts
 *
 * Then make yourself non-admin and restart so you stop bypassing the gate:
 *   in .env set  CANVAS_DROP_ADMIN_EMAILS=nobody@example.com  and restart `pnpm dev`.
 * Open the printed URL, and the gate appears. The right password lets you in; a
 * wrong one is rejected. Revert by clearing CANVAS_DROP_ADMIN_EMAILS + restarting.
 */
import { loadConfig } from "@canvas-drop/shared";
import { generateApiKey, hashApiKey } from "../src/canvas/api-key.js";
import { hashPassword } from "../src/canvas/password.js";
import { generateUniqueSlug } from "../src/canvas/slug.js";
import { canvasUrl } from "../src/canvas/url.js";
import { makeDb } from "../src/db/factory.js";
import { runMigrations } from "../src/db/migrate.js";
import { canvasesRepository } from "../src/db/repositories/canvases.js";
import { usersRepository } from "../src/db/repositories/users.js";
import { versionsRepository } from "../src/db/repositories/versions.js";
import { deployEngine } from "../src/deploy/engine.js";
import { fromPasteHtml } from "../src/deploy/ingest.js";
import { createLogger } from "../src/log/logger.js";
import { makeStorage } from "../src/storage/factory.js";

const PASSWORD = "hunter2";

async function main() {
  const config = loadConfig();
  const log = createLogger(config);
  const db = makeDb(config);
  await runMigrations(db); // no-op if the dev server already migrated

  const users = usersRepository(db);
  const canvases = canvasesRepository(db);
  const versions = versionsRepository(db);
  const storage = makeStorage(config);
  const engine = deployEngine({ config, canvases, versions, storage, log });

  // A second user who OWNS the canvas — so your dev user is a non-owner viewer.
  const owner = await users.upsert({
    providerSub: "demo:gate-owner",
    email: "gate-owner@example.com",
    name: "Gate Owner",
    isAdmin: false,
  });

  const slug = await generateUniqueSlug(async (s) => (await canvases.findBySlug(s)) !== null);
  const canvas = await canvases.create({
    ownerId: owner.id,
    slug,
    apiKeyHash: hashApiKey(generateApiKey()),
    title: "Password gate demo",
  });

  await canvases.updateSettings(canvas.id, { shared: true });
  await canvases.setPassword(canvas.id, await hashPassword(PASSWORD));
  await engine.deploy(
    canvas,
    "paste",
    fromPasteHtml("<!doctype html><h1>Secret canvas</h1><p>You made it past the gate.</p>"),
    owner.id,
  );

  const url = canvasUrl(config, slug);
  await db.close();

  process.stdout.write(
    [
      "",
      "Seeded a password-gated canvas owned by another user:",
      `   URL:      ${url}`,
      `   Password: ${PASSWORD}`,
      "",
      "To see the gate in your browser:",
      "  1. In .env set  CANVAS_DROP_ADMIN_EMAILS=nobody@example.com  (so you're not admin),",
      "     then restart `pnpm dev`.",
      "  2. Open the URL above. As a non-owner, non-admin viewer of a shared + password",
      "     canvas, you'll get the gate. Enter the password to get in; a wrong one is rejected.",
      "  Revert: clear CANVAS_DROP_ADMIN_EMAILS (or set it back) and restart.",
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
