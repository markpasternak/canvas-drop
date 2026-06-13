import type { Canvas, User } from "@canvas-drop/shared/db";
import type { Logger } from "../log/logger.js";

/**
 * Hono context variables available across the app. Populated by the middleware
 * chain: correlation-id/logging (U3), client IP (U11 conninfo), auth gateway (U7),
 * canvas routing/authorization (U15).
 */
export interface AppVariables {
  log: Logger;
  correlationId: string;
  /** Real socket peer IP (set by the conninfo middleware) — used for trusted-proxy checks (U8). */
  clientIp?: string;
  /** The authenticated user — guaranteed set by the auth gateway on protected routes. */
  user: User;
  /** Resolved request role (set by the app's role middleware, U11/U19). */
  role?: "dashboard" | "auth" | "platform-api" | "canvas";
  /** Canvas slug from resolveRequest (canvas + platform-api roles). */
  canvasSlug?: string;
  /** The authorized canvas — set by canvasAccess (U15) on allow. */
  canvas?: Canvas;
  /** Whether the password gate must run before serving — set by canvasAccess (U15). */
  needsPasswordGate?: boolean;
}

/** The Hono `Env` binding for every route and middleware in the server. */
export interface AppEnv {
  Variables: AppVariables;
}
