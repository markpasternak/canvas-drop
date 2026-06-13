import { ConfigError, loadConfig } from "@canvas-drop/shared";
import { serve } from "@hono/node-server";
import { buildApp } from "./app.js";
import { createAuditLog } from "./audit/audit-log.js";
import { setupAuth } from "./auth/factory.js";
import { makeOidc, makeOidcConfigLoader } from "./auth/oidc.js";
import { makeDb } from "./db/factory.js";
import { runMigrations } from "./db/migrate.js";
import { auditRepository } from "./db/repositories/audit.js";
import { canvasesRepository } from "./db/repositories/canvases.js";
import { usersRepository } from "./db/repositories/users.js";
import { versionsRepository } from "./db/repositories/versions.js";
import { deployEngine } from "./deploy/engine.js";
import { createLogger } from "./log/logger.js";
import { makeStorage } from "./storage/factory.js";

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
  const audit = createAuditLog(auditRepository(db), rootLogger);
  const engine = deployEngine({ config, canvases, versions, storage, log: rootLogger });
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

  // 4. Compose and serve.
  const app = buildApp({
    config,
    db,
    rootLogger,
    strategy,
    users,
    canvases,
    versions,
    storage,
    engine,
    audit,
    sessionSvc,
    oidc,
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

  // Graceful shutdown: stop accepting connections and let in-flight requests
  // finish BEFORE flushing audit writes and closing the DB pool — otherwise a
  // request mid-handler loses its connection and its audit row.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
