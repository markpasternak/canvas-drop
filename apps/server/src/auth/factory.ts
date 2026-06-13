import type { Config } from "@canvas-drop/shared";
import { createRemoteJWKSet } from "jose";
import type { SessionsRepository } from "../db/repositories/sessions.js";
import type { UsersRepository } from "../db/repositories/users.js";
import { devStrategy } from "./dev.js";
import { proxyStrategy } from "./proxy.js";
import { type SessionService, sessionBackedStrategy, sessionService } from "./session.js";
import type { AuthStrategy } from "./strategy.js";

export interface AuthDeps {
  users: UsersRepository;
  sessions: SessionsRepository;
}

export interface AuthSetup {
  strategy: AuthStrategy;
  /** Present in oidc/dev modes (used for logout); undefined in proxy mode. */
  sessionSvc?: SessionService;
}

/**
 * Build the auth strategy (and session service where applicable) for the
 * configured mode (KTD-2). Used by app assembly (U11); unit tests construct the
 * individual strategies directly.
 */
export function setupAuth(config: Config, deps: AuthDeps): AuthSetup {
  if (config.auth.mode === "dev") {
    return { strategy: devStrategy(config), sessionSvc: sessionService(config, deps.sessions) };
  }

  if (config.auth.mode === "proxy") {
    const { jwksUrl } = config.auth.proxy;
    const jwks = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : undefined;
    return { strategy: proxyStrategy(config, jwks) };
  }

  // oidc: identity comes from the app session; login routes establish it (U11)
  const sessionSvc = sessionService(config, deps.sessions);
  return { strategy: sessionBackedStrategy(sessionSvc, deps.users), sessionSvc };
}
