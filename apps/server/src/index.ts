import { ConfigError, loadConfig, presentEnvVars } from "@canvas-drop/shared";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { runLegacyGuestCutover } from "./access/legacy-guest-cutover.js";
import { adminSettingsService } from "./admin/settings-service.js";
import { buildApp } from "./app.js";
import { createAuditLog } from "./audit/audit-log.js";
import { setupAuth } from "./auth/factory.js";
import { makeOidc, makeOidcConfigLoader } from "./auth/oidc.js";
import { canvasUrl } from "./canvas/url.js";
import { backfillSearchText, countMissingSearchText } from "./db/backfill-search-text.js";
import { makeDb } from "./db/factory.js";
import { runMigrations } from "./db/migrate.js";
import { allowedEmailsRepository } from "./db/repositories/allowed-emails.js";
import { auditRepository } from "./db/repositories/audit.js";
import { canvasesRepository } from "./db/repositories/canvases.js";
import { draftsRepository } from "./db/repositories/drafts.js";
import { emailTemplatesRepository } from "./db/repositories/email-templates.js";
import { guestRepository } from "./db/repositories/guest.js";
import { invitationsRepository } from "./db/repositories/invitations.js";
import { orgsRepository } from "./db/repositories/orgs.js";
import { screenshotsRepository } from "./db/repositories/screenshots.js";
import { settingsRepository } from "./db/repositories/settings.js";
import { teamsRepository } from "./db/repositories/teams.js";
import { uploadSessionsRepository } from "./db/repositories/upload-sessions.js";
import { usersRepository } from "./db/repositories/users.js";
import { versionsRepository } from "./db/repositories/versions.js";
import { deployEngine } from "./deploy/engine.js";
import { seedDefaultTemplates } from "./email/templates.js";
import { createLogger } from "./log/logger.js";
import { runOpsCli } from "./ops/cli.js";
import { createHub } from "./realtime/hub.js";
import { CAPTURE_VIEWPORT, type CaptureContext } from "./screenshots/capture.js";
import { screenshotTrigger } from "./screenshots/trigger.js";
import { startScreenshotWorker } from "./screenshots/worker.js";
import { makeStorage } from "./storage/factory.js";
import { materializeOrg } from "./tenancy/materialize-org.js";

/** Periodic realtime re-authorization (D-RT-6 backstop, §9.7 default 60s). */
const REALTIME_HEARTBEAT_MS = 60_000;

async function main() {
  // Maintenance subcommands (backup / restore / purge) run and exit instead of starting
  // the server — same binary, so prod cron runs the app image directly (see docs/ops.md).
  if (await runOpsCli(process.argv.slice(2))) return;

  // 1. Config — the only process.env reader; fail loud on invalid combos.
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

  const rootLogger = createLogger(config);

  // 2. Drivers (DB, storage, auth) — all behind config-selected factories.
  const db = makeDb(config);
  await runMigrations(db); // dev convenience; ops run migrations explicitly in prod
  const storage = makeStorage(config);
  const users = usersRepository(db);
  const allowedEmails = allowedEmailsRepository(db);
  const orgs = orgsRepository(db);
  const teams = teamsRepository(db);
  const canvases = canvasesRepository(db);
  const versions = versionsRepository(db);
  const drafts = draftsRepository(db);
  const uploadSessions = uploadSessionsRepository(db);
  const audit = createAuditLog(auditRepository(db), rootLogger);

  // Tenancy (plan 002 U2): materialize the single configured org + its domains and run
  // the boot guards BEFORE serving — fail-loud, so a tenancy misconfig can't mis-scope
  // the whole_org boundary. No-op when no org is named (tenancy inert).
  await materializeOrg({ config, orgs, log: rootLogger });

  // Email templates (plan 003 phase 3): idempotently seed the default invite/notification
  // templates so an admin always has editable rows; an existing override is never clobbered.
  const emailTemplates = emailTemplatesRepository(db);
  await seedDefaultTemplates(emailTemplates);

  // Screenshot enablement (plan 004): one settings resolver + one capture trigger,
  // shared by the deploy engine (deploy publishes) and the worker. The trigger
  // self-gates on effectiveScreenshotsEnabled (env-available AND admin-enabled) and is
  // best-effort, so wiring it everywhere is safe — when off it's a no-op.
  const screenshotSettings = adminSettingsService({
    settings: settingsRepository(db),
    config,
    envPresent: presentEnvVars(),
  });
  const screenshots = screenshotTrigger({
    enabled: () => screenshotSettings.effectiveScreenshotsEnabled(),
    repo: screenshotsRepository(db),
    log: rootLogger,
  });

  const engine = deployEngine({
    config,
    canvases,
    versions,
    drafts,
    storage,
    log: rootLogger,
    uploadSessions,
    screenshots,
  });
  const { strategy, sessionSvc } = setupAuth(config, {
    users,
    sessions: (await import("./db/repositories/sessions.js")).sessionsRepository(db),
    audit,
  });

  // 3. OIDC login routes (oidc mode only).
  const oidc =
    config.auth.mode === "oidc" && sessionSvc
      ? makeOidc({
          config,
          users,
          allowedEmails,
          sessionSvc,
          getConfig: makeOidcConfigLoader(config),
        })
      : undefined;

  // 3b. Guest magic-link service (U6/U7) — the carve-out is app-gated, so it only
  //     exists outside proxy mode (in proxy mode the IAP authenticates first).
  const { guestService } = await import("./auth/guest.js");
  const { setupMailer } = await import("./email/factory.js");
  const guestRepo = guestRepository(db);
  await runLegacyGuestCutover({
    config,
    users,
    allowedEmails,
    invitations: invitationsRepository(db),
    canvases,
    guests: guestRepo,
    log: rootLogger,
  });
  const guests = config.auth.mode === "proxy" ? undefined : guestService(config, guestRepo);
  const mailer = config.auth.mode === "proxy" ? undefined : setupMailer(config, rootLogger);

  // 4. Realtime hub (single-process, in-memory). Re-fetches the canvas + user for
  //    live re-authorization (revoke-drops-socket + heartbeat).
  const hub = createHub({
    config,
    resolveCanvas: (id) => canvases.findById(id),
    isUserActive: async (id) => {
      const u = await users.findById(id);
      return !!u && !u.isBlocked;
    },
    // Live re-auth of a specific_people canvas needs allowlist membership (U3).
    isPrincipalAllowed: (canvasId, principal) => canvases.isPrincipalAllowed(canvasId, principal),
    // …and a team canvas needs the live team re-join (plan 003 U4).
    teamMatch: (canvasId, userId, viewerOrgIds) => teams.teamMatch(canvasId, userId, viewerOrgIds),
  });

  // 5. Compose and serve. createNodeWebSocket needs the app instance, and the WS
  //    route needs its upgradeWebSocket helper — resolve the cycle by handing
  //    buildApp a registerWebSocket callback and capturing injectWebSocket here.
  let injectWebSocket: ((server: ReturnType<typeof serve>) => void) | undefined;
  const app = buildApp({
    config,
    envPresent: presentEnvVars(),
    db,
    rootLogger,
    strategy,
    users,
    allowedEmails,
    orgs,
    canvases,
    versions,
    drafts,
    storage,
    engine,
    audit,
    sessionSvc,
    guests,
    mailer,
    oidc,
    hub,
    registerWebSocket: (honoApp) => {
      const nodeWs = createNodeWebSocket({ app: honoApp, baseUrl: config.baseUrl });
      injectWebSocket = nodeWs.injectWebSocket as typeof injectWebSocket;
      return nodeWs.upgradeWebSocket;
    },
  });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    rootLogger.info(
      {
        port: info.port,
        urlMode: config.urlMode,
        db: config.db.driver,
        storage: config.storage.driver,
        auth: config.auth.mode,
      },
      `canvas-drop listening on http://localhost:${info.port}`,
    );
  });

  // Attach the WebSocket upgrade handler to the underlying http.Server (realtime
  // primitive). MUST run after serve() returns the server.
  injectWebSocket?.(server);

  // Idempotent boot-time `search_text` backfill (plan 2026-06-19, KTD1): the column
  // is maintained on every write, but rows that predate it carry NULL and would be
  // invisible to `?q=` until next edited. Populate any NULL rows once, reusing the
  // SAME shared core the manual `pnpm backfill:search-text` uses. NULL-only and chunked
  // in transactions, so the steady state pays only a cheap count and a partial failure
  // can't half-apply. Fired AFTER the listener is serving (and in the background) so a
  // large first-deploy backfill can't delay readiness — best-effort: an error must not
  // affect the running server (search degrades for un-backfilled rows; everything else
  // works), and the NULL-only guard keeps a re-run on the next boot idempotent.
  void (async () => {
    try {
      if ((await countMissingSearchText(db)) > 0) {
        const filled = await backfillSearchText(db);
        rootLogger.info({ filled }, "search_text backfill: populated NULL rows after boot");
      }
    } catch (err) {
      rootLogger.error({ err }, "search_text backfill failed after boot (continuing)");
    }
  })();

  // Screenshot worker (plan 004). Only starts when the env makes capture AVAILABLE
  // (Chromium present); even then it stays idle until an admin enables the runtime
  // toggle (effectiveScreenshotsEnabled). When unavailable it's fully inert — the
  // product behaves exactly like today. Started AFTER serve() so the worker's loopback
  // capture requests reach a listening server. Reuses the `screenshotSettings` resolver
  // built above (shared with the deploy-path trigger).
  const screenshotWorkerCtl = startScreenshotWorker({
    config,
    enabled: () => screenshotSettings.effectiveScreenshotsEnabled(),
    jobs: screenshotsRepository(db),
    canvases,
    storage,
    // The worker always renders against the LOOPBACK server (no external DNS/TLS/proxy
    // hop). Path mode → the `/c/{slug}/` route on loopback. Subdomain mode → the
    // canvas's real subdomain URL (over http), which the browser's host-resolver rules
    // (set at launch below) map to the loopback server — so the request carries the
    // correct Host (and `resolveRequest` picks the right canvas) without leaving the box.
    captureUrlFor: (canvas) =>
      config.urlMode === "subdomain"
        ? `http://${new URL(canvasUrl(config, canvas.slug)).host}/`
        : `http://127.0.0.1:${config.port}/c/${canvas.slug}/`,
    launchBrowser: async () => {
      const { chromium } = await import("playwright");
      // Subdomain mode: map every `*.{baseHost}` to the loopback server so the worker
      // can hit a canvas's real subdomain URL internally (correct Host, no external hop).
      const args: string[] = [];
      if (config.urlMode === "subdomain") {
        const baseHost = new URL(config.baseUrl).hostname;
        args.push(`--host-resolver-rules=MAP *.${baseHost} 127.0.0.1:${config.port}`);
      }
      const browser = await chromium.launch({ args });
      return {
        // deviceScaleFactor: 2 → retina-resolution master (2× pixel density), so the
        // downscaled WebP renditions have crisp text/edges instead of looking soft.
        newContext: async () =>
          (await browser.newContext({
            viewport: { width: CAPTURE_VIEWPORT.width, height: CAPTURE_VIEWPORT.height },
            deviceScaleFactor: 2,
          })) as unknown as CaptureContext & { close(): Promise<void> },
        close: () => browser.close(),
      };
    },
    log: rootLogger,
  });

  // Realtime heartbeat backstop: re-authorize live sockets so time-based expiry
  // and admin block/delete (which fire no mutation hook) drop within one tick.
  const heartbeat = setInterval(() => {
    for (const id of hub.activeCanvasIds()) {
      void hub.revalidateCanvas(id).catch(() => {});
    }
  }, REALTIME_HEARTBEAT_MS);

  // Fail loud and readable on a bound port instead of letting the underlying
  // http.Server emit an unhandled 'error' event (which crashes with a raw stack
  // trace). The usual dev cause is a previous server that never exited — see the
  // graceful-shutdown note below.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // Human-facing startup hint → stderr directly, matching the fatal handler
      // below (pino mangles multi-line string messages).
      process.stderr.write(
        `Port ${config.port} is already in use — another canvas-drop server is probably still running.\n` +
          `  Find it:  lsof -nP -iTCP:${config.port} -sTCP:LISTEN\n` +
          `  Then kill the PID, or set CANVAS_DROP_PORT to a free port.\n`,
      );
    } else {
      rootLogger.error({ err }, "server failed to start");
    }
    process.exit(1);
  });

  // Graceful shutdown: stop accepting connections and let in-flight requests
  // finish BEFORE flushing audit writes and closing the DB pool — otherwise a
  // request mid-handler loses its connection and its audit row.
  //
  // Critically, we must drop *idle* keep-alive sockets ourselves: server.close()
  // waits for every connection to end, and browsers / the Vite dev proxy hold
  // keep-alive sockets open indefinitely. Without this the process never exits,
  // the port stays bound, and you get EADDRINUSE on the next start *and* failed
  // tsx-watch reloads. The force timer is the backstop for genuinely slow
  // in-flight requests.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    hub.closeAll(); // close live WebSockets before draining HTTP
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    const force = setTimeout(() => {
      if ("closeAllConnections" in server) server.closeAllConnections();
    }, 5_000);
    force.unref?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearTimeout(force);
    await screenshotWorkerCtl.stop(); // close the persistent browser, if any
    await audit.flush();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
