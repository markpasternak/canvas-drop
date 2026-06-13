import type { Config } from "@canvas-drop/shared";
import { devStrategy } from "./dev.js";
import type { AuthStrategy } from "./strategy.js";

/**
 * Select the auth strategy for the configured mode (KTD-2). Proxy (U8) and OIDC
 * (U9) extend this switch with their dependencies.
 */
export function makeAuthStrategy(config: Config): AuthStrategy {
  if (config.auth.mode === "dev") return devStrategy(config);
  if (config.auth.mode === "proxy") {
    throw new Error("proxy auth strategy is wired in U8");
  }
  throw new Error("oidc auth strategy is wired in U9");
}
