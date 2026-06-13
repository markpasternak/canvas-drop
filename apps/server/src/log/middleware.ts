import { createMiddleware } from "hono/factory";
import { v7 as uuidv7 } from "uuid";
import type { AppEnv } from "../http/types.js";
import type { Logger } from "./logger.js";

/** Paths excluded from per-request logging (noise reduction). */
const EXCLUDED_PATHS = new Set(["/healthz", "/metrics"]);

/**
 * Per-request logging + correlation ID (BUILD_BRIEF.md §8.5).
 *
 * Reads an inbound `X-Correlation-ID` / `X-Request-Id` (or generates a UUIDv7),
 * binds a child logger to the request context, echoes the id on the response,
 * and logs request start/end with method, path, status, and duration. Health
 * and metrics paths are excluded.
 */
export function requestLogger(root: Logger) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const incoming = c.req.header("x-correlation-id") ?? c.req.header("x-request-id");
    const correlationId = incoming ?? uuidv7();
    const log = root.child({ correlationId });

    c.set("log", log);
    c.set("correlationId", correlationId);
    c.header("X-Correlation-ID", correlationId);

    const { method } = c.req;
    const path = c.req.path;
    const excluded = EXCLUDED_PATHS.has(path);

    const start = performance.now();
    if (!excluded) log.info({ method, path }, "request:start");

    await next();

    if (!excluded) {
      const durationMs = Math.round(performance.now() - start);
      log.info({ method, path, status: c.res.status, durationMs }, "request:end");
    }
  });
}
