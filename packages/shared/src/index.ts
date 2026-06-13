/**
 * @canvas-drop/shared — cross-cutting types, schemas, and utilities shared
 * across the server, dashboard, and SDK.
 */
export const VERSION = "0.0.0";

export * from "./capabilities/index.js";
export { type Config, ConfigError, loadConfig } from "./config/env.js";
