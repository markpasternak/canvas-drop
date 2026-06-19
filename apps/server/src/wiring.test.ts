import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { adminSettingsService } from "./admin/settings-service.js";
import { createAuditLog } from "./audit/audit-log.js";
import type { DbClient } from "./db/factory.js";
import { auditRepository } from "./db/repositories/audit.js";
import { canvasesRepository } from "./db/repositories/canvases.js";
import { draftsRepository } from "./db/repositories/drafts.js";
import { settingsRepository } from "./db/repositories/settings.js";
import { usersRepository } from "./db/repositories/users.js";
import { versionsRepository } from "./db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "./db/testing.js";
import { deployEngine } from "./deploy/engine.js";
import type { DeployEntry } from "./deploy/ingest.js";
import { memStorage } from "./storage/mem.js";
import { composeServices } from "./wiring.js";

const silent = pino({ level: "silent" });
const enc = (s: string) => new TextEncoder().encode(s);

async function* folder(files: Record<string, string>): AsyncGenerator<DeployEntry> {
  for (const [path, body] of Object.entries(files)) yield { path, bytes: enc(body) };
}

/**
 * Wiring-level guard for the agent-native parity rule. composeServices builds the
 * draft service ONCE — with its screenshot trigger always wired — and every publish
 * path (the editor's draft API AND the MCP `publish_draft` tool) shares that one
 * instance. This test exercises the composed `drafts.publish` and asserts it really
 * schedules a capture when screenshots are effective-enabled, so a future edit that
 * drops the trigger from the shared graph fails here. (Regression: the MCP-mounted
 * draftService once lacked the trigger, so MCP publishes silently skipped capture.)
 */
describe.each(DIALECTS)("composeServices — shared draft publish wiring (%s)", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  // Screenshots available at the env layer (master enable) — the admin toggle is
  // set per-test below, so effectiveScreenshotsEnabled() resolves env AND admin.
  const config: Config = loadConfig({
    CANVAS_DROP_AUTH_MODE: "dev",
    CANVAS_DROP_SCREENSHOTS: "on",
  });

  async function setup(screenshotsAdminEnabled: boolean) {
    client = await makeTestDb(dialect);
    const storage = memStorage();
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const draftsRepo = draftsRepository(client);
    const audit = createAuditLog(auditRepository(client), silent);
    // One settings repo: the admin service reads the toggle the test writes below
    // through the SAME instance (no stale read if the repo ever memoizes).
    const settingsRepo = settingsRepository(client);
    const settings = adminSettingsService({ settings: settingsRepo, config });
    if (screenshotsAdminEnabled) {
      await settingsRepo.set("config.screenshots.enabled", true);
    }
    const engine = deployEngine({
      config,
      canvases,
      versions,
      drafts: draftsRepo,
      storage,
      log: silent,
    });
    const services = composeServices({
      config,
      db: client,
      log: silent,
      users,
      canvases,
      versions,
      draftsRepo,
      storage,
      engine,
      audit,
      settings,
    });
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const cv = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "k" });
    // Seed v1 so the draft is non-empty and publish() can snapshot it into v2.
    await engine.deploy(cv, "folder", folder({ "index.html": "<h1>v1</h1>" }), owner.id);
    const live = (await canvases.findById(cv.id)) as Canvas;
    return { services, canvas: live, owner };
  }

  it("publishing the shared draft enqueues a screenshot capture when enabled", async () => {
    const { services, canvas, owner } = await setup(true);
    const result = await services.drafts.publish(canvas, owner.id);

    // The shared trigger ran through to the jobs repo: a pending capture for the
    // freshly published version exists — the same effect the editor produces, now
    // guaranteed for the MCP publish path too.
    const job = await services.screenshots.findByCanvas(canvas.id);
    expect(job).not.toBeNull();
    expect(job?.versionId).toBe(result.versionId);
    expect(job?.status).toBe("pending");
  });

  it("publishing enqueues nothing when the admin screenshot toggle is off", async () => {
    const { services, canvas, owner } = await setup(false);
    await services.drafts.publish(canvas, owner.id);
    expect(await services.screenshots.findByCanvas(canvas.id)).toBeNull();
  });
});
