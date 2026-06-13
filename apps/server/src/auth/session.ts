import type { Config } from "@canvas-drop/shared";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { generateSessionToken, type SessionsRepository } from "../db/repositories/sessions.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { AppEnv } from "../http/types.js";
import type { AuthStrategy, ResolvedIdentity } from "./strategy.js";

/** App session cookie name (oidc/dev modes; proxy mode is sessionless, KTD-5). */
export const SESSION_COOKIE = "__canvasdrop_session";

/** 14-day rolling expiry (§6.3.9). */
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface SessionService {
  /** Mint a session for a user and set the cookie. */
  issue(c: Context<AppEnv>, userId: string): Promise<void>;
  /** Resolve the cookie to a live session's user id, rolling the expiry forward. */
  resolveUserId(c: Context<AppEnv>): Promise<string | null>;
  /** Revoke the current session and clear the cookie. */
  revoke(c: Context<AppEnv>): Promise<void>;
}

/** Minimal audit sink for session lifecycle events (§12.1.8). Implemented by AuditLog. */
export interface SessionAuditSink {
  recordAudit(input: { action: string; actorId?: string | null; ip?: string | null }): void;
}

export function sessionService(
  config: Config,
  sessions: SessionsRepository,
  audit?: SessionAuditSink,
): SessionService {
  // HttpOnly always; Secure in production; SameSite=Lax. Subdomain mode scopes
  // the cookie to `.{baseHost}` so canvases share it; path mode is host-only.
  const cookie = () => ({
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "Lax" as const,
    path: "/",
    ...(config.urlMode === "subdomain" ? { domain: `.${new URL(config.baseUrl).hostname}` } : {}),
  });

  return {
    async issue(c, userId) {
      const token = generateSessionToken();
      await sessions.create({
        userId,
        token,
        expiresAt: Date.now() + TTL_MS,
        ip: c.get("clientIp") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
      });
      setCookie(c, SESSION_COOKIE, token, { ...cookie(), maxAge: Math.floor(TTL_MS / 1000) });
      audit?.recordAudit({ action: "session_create", actorId: userId, ip: c.get("clientIp") });
    },

    async resolveUserId(c) {
      const token = getCookie(c, SESSION_COOKIE);
      if (!token) return null;
      const session = await sessions.findLiveByToken(token);
      if (!session) return null;
      await sessions.touchExpiry(token, Date.now() + TTL_MS);
      setCookie(c, SESSION_COOKIE, token, { ...cookie(), maxAge: Math.floor(TTL_MS / 1000) });
      return session.userId;
    },

    async revoke(c) {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) {
        // Resolve the owner before revoking so the audit row is attributed.
        const session = await sessions.findLiveByToken(token);
        await sessions.revokeByToken(token);
        if (session) {
          audit?.recordAudit({
            action: "session_revoke",
            actorId: session.userId,
            ip: c.get("clientIp"),
          });
        }
      }
      deleteCookie(c, SESSION_COOKIE, cookie());
    },
  };
}

/**
 * Auth strategy backed by the app session cookie (oidc mode). The OIDC
 * login/callback routes establish the session; every subsequent request
 * resolves identity from it.
 */
export function sessionBackedStrategy(
  sessionSvc: SessionService,
  users: UsersRepository,
): AuthStrategy {
  return {
    async resolveIdentity(c): Promise<ResolvedIdentity | null> {
      const userId = await sessionSvc.resolveUserId(c);
      if (!userId) return null;
      const user = await users.findById(userId);
      if (!user) return null;
      return {
        sub: user.providerSub,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl ?? undefined,
      };
    },
  };
}
