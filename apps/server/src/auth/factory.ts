import type { Config } from "@canvas-drop/shared";
import { createRemoteJWKSet } from "jose";
import { devStrategy } from "./dev.js";
import { proxyStrategy } from "./proxy.js";
import type { AuthStrategy } from "./strategy.js";

/**
 * Select the auth strategy for the configured mode (KTD-2). OIDC (U9) extends
 * this switch with its dependencies.
 */
export function makeAuthStrategy(config: Config): AuthStrategy {
  if (config.auth.mode === "dev") return devStrategy(config);
  if (config.auth.mode === "proxy") {
    const { jwksUrl } = config.auth.proxy;
    const jwks = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : undefined;
    return proxyStrategy(config, jwks);
  }
  throw new Error("oidc auth strategy is wired in U9");
}
