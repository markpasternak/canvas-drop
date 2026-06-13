import type { Logger } from "../log/logger.js";

/**
 * Hono context variables available across the app. Units add to this as the
 * middleware chain grows (U7 adds the authenticated `user`).
 */
export interface AppVariables {
  log: Logger;
  correlationId: string;
}

/** The Hono `Env` binding for every route and middleware in the server. */
export interface AppEnv {
  Variables: AppVariables;
}
