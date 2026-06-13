import type { User } from "@canvas-drop/shared/db";
import type { Logger } from "../log/logger.js";

/**
 * Hono context variables available across the app. Populated by the middleware
 * chain: correlation-id/logging (U3), client IP (U11 conninfo), auth gateway (U7).
 */
export interface AppVariables {
  log: Logger;
  correlationId: string;
  /** Real socket peer IP (set by the conninfo middleware) — used for trusted-proxy checks (U8). */
  clientIp?: string;
  /** The authenticated user — guaranteed set by the auth gateway on protected routes. */
  user: User;
}

/** The Hono `Env` binding for every route and middleware in the server. */
export interface AppEnv {
  Variables: AppVariables;
}
