import type { Context } from "hono";
import type { AppEnv } from "../http/types.js";

/**
 * Identity resolved from the active auth mode. Shape versioned for later
 * directory fields (D15). `sub` is the stable provider subject.
 */
export interface ResolvedIdentity {
  sub: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

/**
 * One interface per auth mode (KTD-2). The gateway and every downstream module
 * are mode-agnostic — they only see a {@link ResolvedIdentity} or `null`.
 */
export interface AuthStrategy {
  resolveIdentity(c: Context<AppEnv>): Promise<ResolvedIdentity | null>;
}
