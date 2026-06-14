/**
 * @canvas-drop/shared — cross-cutting types, schemas, and utilities shared
 * across the server, dashboard, and SDK.
 */
export const VERSION = "0.0.0";

export * from "./capabilities/index.js";
export {
  AUTH_MODES,
  type AuthMode,
  type Config,
  ConfigError,
  loadConfig,
  presentEnvVars,
} from "./config/env.js";
