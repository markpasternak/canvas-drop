import type { Config } from "@canvas-drop/shared";
import type { AdminSettingsService } from "./admin/settings-service.js";
import type { AuditLog } from "./audit/audit-log.js";
import { type CloneService, cloneService } from "./canvas/clone-service.js";
import type { DbClient } from "./db/factory.js";
import { aiUsageRepository } from "./db/repositories/ai-usage.js";
import type { CanvasesRepository } from "./db/repositories/canvases.js";
import type { DraftsRepository } from "./db/repositories/drafts.js";
import { filesRepository } from "./db/repositories/files.js";
import { oauthRepository } from "./db/repositories/oauth.js";
import { screenshotsRepository } from "./db/repositories/screenshots.js";
import { uploadSessionsRepository } from "./db/repositories/upload-sessions.js";
import { usageEventsRepository } from "./db/repositories/usage-events.js";
import type { UsersRepository } from "./db/repositories/users.js";
import type { VersionsRepository } from "./db/repositories/versions.js";
import type { DeployEngine } from "./deploy/engine.js";
import { type DraftService, draftService } from "./draft/service.js";
import type { Logger } from "./log/logger.js";
import { screenshotTrigger } from "./screenshots/trigger.js";
import type { StorageDriver } from "./storage/driver.js";
import { type UploadService, uploadService } from "./upload/service.js";

/**
 * Inputs the shared service graph needs. A subset of {@link BuildAppDeps} (the
 * persistence + driver seams) plus the already-built admin settings service,
 * whose effective-screenshot gate the draft publish path reads.
 */
export interface ServiceGraphDeps {
  config: Config;
  db: DbClient;
  log: Logger;
  users: UsersRepository;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  /** The drafts *repository* (storage seam) — distinct from the draft *service* below. */
  draftsRepo: DraftsRepository;
  storage: StorageDriver;
  engine: DeployEngine;
  audit: AuditLog;
  settings: AdminSettingsService;
}

/**
 * The shared service graph (composition root, §9.1). Every member is a stateless
 * wrapper over `deps.db` and the injected drivers, so it is constructed exactly
 * ONCE here and shared by every route mount that needs it (the Bearer deploy API,
 * the MCP control plane, the session management/draft APIs, …).
 *
 * Building the graph in one place — rather than inline per `app.route(...)` — is
 * what makes the agent-native parity rule (AGENTS.md) *structural* rather than
 * conventional: the MCP surface and the dashboard HTTP routes demonstrably wrap
 * the SAME service instances, so a side effect wired into one (e.g. the screenshot
 * capture the editor's `draftService.publish` schedules) cannot silently go
 * missing from the other. A past bug — the MCP `draftService` lacking the
 * screenshot trigger, so MCP `publish_draft` skipped the capture the editor did —
 * is impossible once the service is built once and shared.
 */
export interface ServiceGraph {
  usage: ReturnType<typeof usageEventsRepository>;
  screenshots: ReturnType<typeof screenshotsRepository>;
  files: ReturnType<typeof filesRepository>;
  aiUsage: ReturnType<typeof aiUsageRepository>;
  oauth: ReturnType<typeof oauthRepository>;
  upload: UploadService;
  clone: CloneService;
  /** The draft *service* — one instance, screenshot trigger always wired, shared by
   *  EVERY publish path (the editor's draft API AND the MCP `publish_draft` tool). */
  drafts: DraftService;
}

/** Build the shared service graph once (see {@link ServiceGraph}). */
export function composeServices(deps: ServiceGraphDeps): ServiceGraph {
  const screenshots = screenshotsRepository(deps.db);

  return {
    usage: usageEventsRepository(deps.db),
    screenshots,
    files: filesRepository(deps.db),
    aiUsage: aiUsageRepository(deps.db),
    oauth: oauthRepository(deps.db),

    // Two-channel staging upload service (plan 003) — shared by the Bearer-key
    // deploy API and the MCP surface, over one content-addressed core.
    upload: uploadService({
      config: deps.config,
      canvases: deps.canvases,
      users: deps.users,
      uploadSessions: uploadSessionsRepository(deps.db),
      storage: deps.storage,
      engine: deps.engine,
    }),

    clone: cloneService({
      canvases: deps.canvases,
      versions: deps.versions,
      drafts: deps.draftsRepo,
      storage: deps.storage,
    }),

    drafts: draftService({
      config: deps.config,
      canvases: deps.canvases,
      versions: deps.versions,
      drafts: deps.draftsRepo,
      storage: deps.storage,
      audit: deps.audit,
      log: deps.log,
      // Schedule screenshot captures on publish (plan 004 / U6); the worker consumes
      // them. Effective-gated + best-effort — a no-op when capture is off — so it is
      // always wired and shared by EVERY publish path (editor draft-api AND MCP),
      // keeping the two at parity.
      screenshots: screenshotTrigger({
        enabled: () => deps.settings.effectiveScreenshotsEnabled(),
        repo: screenshots,
        log: deps.log,
      }),
    }),
  };
}
