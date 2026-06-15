import { ConfigError, loadConfig, presentEnvVars } from "@canvas-drop/shared";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { buildApp } from "./app.js";
import { createAuditLog } from "./audit/audit-log.js";
import { setupAuth } from "./auth/factory.js";
import { makeOidc, makeOidcConfigLoader } from "./auth/oidc.js";
import { makeDb } from "./db/factory.js";
import { runMigrations } from "./db/migrate.js";
import { auditRepository } from "./db/repositories/audit.js";
import { canvasesRepository } from "./db/repositories/canvases.js";
import { draftsRepository } from "./db/repositories/drafts.js";
import { usersRepository } from "./db/repositories/users.js";
import { versionsRepository } from "./db/repositories/versions.js";
import { deployEngine } from "./deploy/engine.js";
import { createLogger } from "./log/logger.js";
import { createHub } from "./realtime/hub.js";
import { makeStorage } from "./storage/factory.js";

/** Periodic realtime re-authorization (D-RT-6 backstop, §9.7 default 60s). */
const REALTIME_HEARTBEAT_MS = 60_000;

async function main() {
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
  const canvases = canvasesRepository(db);
  const versions = versionsRepository(db);
  const drafts = draftsRepository(db);
  const audit = createAuditLog(auditRepository(db), rootLogger);
  const engine = deployEngine({ config, canvases, versions, drafts, storage, log: rootLogger });
  const { strategy, sessionSvc } = setupAuth(config, {
    users,
    sessions: (await import("./db/repositories/sessions.js")).sessionsRepository(db),
    audit,
  });

  // 3. OIDC login routes (oidc mode only).
  const oidc =
    config.auth.mode === "oidc" && sessionSvc
      ? makeOidc({ config, users, sessionSvc, getConfig: makeOidcConfigLoader(config) })
      : undefined;

  // 3b. Guest magic-link service (U6/U7) — the carve-out is app-gated, so it only
  //     exists outside proxy mode (in proxy mode the IAP authenticates first).
  const { guestRepository } = await import("./db/repositories/guest.js");
  const { guestService } = await import("./auth/guest.js");
  const guests =
    config.auth.mode === "proxy" ? undefined : guestService(config, guestRepository(db));

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
    canvases,
    versions,
    drafts,
    storage,
    engine,
    audit,
    sessionSvc,
    guests,
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
