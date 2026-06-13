import type { Config } from "@canvas-drop/shared";
import type { AuthStrategy } from "./strategy.js";

/**
 * Dev auth strategy (D16) — auto-logs-in a fixed local user with zero setup.
 * Localhost only; the configured dev user's email passes the domain allowlist
 * (which defaults to that email's domain in dev, see config).
 */
export function devStrategy(config: Config): AuthStrategy {
  const { email, name } = config.auth.dev;
  return {
    async resolveIdentity() {
      return { sub: `dev:${email}`, email, name };
    },
  };
}
