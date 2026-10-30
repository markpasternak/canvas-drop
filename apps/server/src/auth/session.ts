import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "@canvas-drop/shared";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { generateSessionToken, type SessionsRepository } from "../db/repositories/sessions.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { AppEnv } from "../http/types.js";
import type { AuthStrategy, ResolvedIdentity } from "./strategy.js";

/** App session cookie name (oidc/dev modes; proxy mode is sessionless, KTD-5). */
export const SESSION_COOKIE = "__canvasdrop_session";

/**
 * Multi-account "account jar" cookie (oidc mode). Holds the raw tokens of the OTHER
 * accounts signed in on this browser, most recently used first, as
 * `<mac>.<token>.<token>…` (`.` never occurs in base64url). Each token is an ordinary
 * session row, so every account keeps the same lifecycle, revocation and gateway checks
 * as the active one. Scoped exactly like {@link SESSION_COOKIE} and equally HttpOnly.
 *
 * The MAC binds the list to the ACTIVE session token it was written alongside. In
 * subdomain mode a canvas's own script can plant a cookie on `.{baseHost}` when none of
 * that name exists yet; without the binding it could push the author's live session
 * into a visitor's jar (login CSRF via the switcher). The author never learns the
 * visitor's session token, so a planted jar never verifies and is ignored.
 */
export const ACCOUNTS_COOKIE = "__canvasdrop_accounts";

/** Most accounts a browser keeps besides the active one (5 in total). */
export const MAX_OTHER_ACCOUNTS = 4;

/** 14-day rolling expiry (§6.3.9). */
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Shape of a token minted by {@link generateSessionToken} (32 bytes, base64url). */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** One signed-in account on this browser, as seen by the account switcher. */
export interface SignedInAccount {
  userId: string;
}

export interface SessionService {
  /** Mint a session for a user and set the cookie. A different account that was
   *  already active on this browser moves into the account jar instead of being
   *  dropped, so signing in again is how a second account is added. */
  issue(c: Context<AppEnv>, userId: string): Promise<void>;
  /** Resolve the cookie to a live session's user id, rolling the expiry forward.
   *  When the active session has ended but the jar still holds an eligible live one,
   *  that account is promoted to active. */
  resolveUserId(c: Context<AppEnv>): Promise<string | null>;
  /** The OTHER live, eligible accounts in this browser's jar (most recently used
   *  first). The active account is never included. */
  otherAccounts(c: Context<AppEnv>): Promise<SignedInAccount[]>;
  /** Make the jar's session for `userId` the active one; the previously active
   *  account moves into the jar. False (nothing changes) when this browser holds no
   *  live session for that user, or the account isn't eligible. */
  switchTo(c: Context<AppEnv>, userId: string): Promise<boolean>;
  /** Revoke the ACTIVE session only. The next eligible account in the jar (if any)
   *  becomes active; returns whether one did. */
  revoke(c: Context<AppEnv>): Promise<{ remaining: boolean }>;
  /** Revoke every session this browser holds and clear both cookies. */
  revokeAll(c: Context<AppEnv>): Promise<void>;
  /** Sign out of one account this browser holds besides the active one (the account
   *  chooser's per-row Sign out). False when no such account is held. */
  revokeHeld(c: Context<AppEnv>, userId: string): Promise<boolean>;
}

/** Minimal audit sink for session lifecycle events (§12.1.8). Implemented by AuditLog. */
export interface SessionAuditSink {
  recordAudit(input: { action: string; actorId?: string | null; ip?: string | null }): void;
}

export interface SessionServiceOptions {
  /** Whether an account could pass the gateway right now (exists, not blocked, still
   *  allowed to sign in). Held accounts that fail it are never listed, switched to or
   *  promoted. Defaults to "yes" (the gateway still re-checks every request). */
  isEligible?: (userId: string) => Promise<boolean>;
}

/** This request's view of the two cookies, updated as the service rewrites them so a
 *  promotion or switch earlier in a request is what later calls see. */
interface CookieState {
  active: string | undefined;
  jar: string[];
}

export function sessionService(
  config: Config,
  sessions: SessionsRepository,
  audit?: SessionAuditSink,
  opts: SessionServiceOptions = {},
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
  const maxAge = Math.floor(TTL_MS / 1000);
  const isEligible = opts.isEligible ?? (async () => true);

  const jarMac = (active: string, tokens: string[]) =>
    createHmac("sha256", config.sessionSecret)
      .update(`accounts:${active}:${tokens.join(".")}`)
      .digest("base64url");

  const states = new WeakMap<Context<AppEnv>, CookieState>();
  const state = (c: Context<AppEnv>): CookieState => {
    const known = states.get(c);
    if (known) return known;
    const active = getCookie(c, SESSION_COOKIE);
    const fresh = { active, jar: active ? parseJar(getCookie(c, ACCOUNTS_COOKIE), active) : [] };
    states.set(c, fresh);
    return fresh;
  };

  /** A jar is trusted only when its MAC matches the active token it was written with. */
  function parseJar(raw: string | undefined, active: string): string[] {
    if (!raw) return [];
    const [mac, ...rest] = raw.split(".");
    if (!mac || rest.length === 0 || rest.length > MAX_OTHER_ACCOUNTS) return [];
    if (!rest.every((t) => TOKEN_RE.test(t))) return [];
    const expected = Buffer.from(jarMac(active, rest));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return [];
    return [...new Set(rest)];
  }

  /** Write both cookies (and this request's view of them). `active: undefined` clears. */
  const write = (c: Context<AppEnv>, active: string | undefined, jar: string[]) => {
    const st = state(c);
    if (active) {
      setCookie(c, SESSION_COOKIE, active, { ...cookie(), maxAge });
    } else if (st.active !== undefined) {
      deleteCookie(c, SESSION_COOKIE, cookie());
    }
    const kept = active ? jar.slice(0, MAX_OTHER_ACCOUNTS) : [];
    if (active && kept.length > 0) {
      setCookie(c, ACCOUNTS_COOKIE, [jarMac(active, kept), ...kept].join("."), {
        ...cookie(),
        maxAge,
      });
    } else if (getCookie(c, ACCOUNTS_COOKIE) !== undefined || st.jar.length > 0) {
      deleteCookie(c, ACCOUNTS_COOKIE, cookie());
    }
    states.set(c, { active, jar: kept });
  };

  const liveUserId = async (token: string | undefined) =>
    token ? ((await sessions.findLiveByToken(token))?.userId ?? null) : null;

  /** The jar's live sessions, in order (dead tokens are dropped on the next write). */
  const liveJar = async (c: Context<AppEnv>) => {
    const tokens = state(c).jar;
    const owners = await Promise.all(tokens.map(liveUserId));
    return tokens.flatMap((token, i) => {
      const userId = owners[i];
      return userId ? [{ token, userId }] : [];
    });
  };

  /** Promote the first live, eligible jar session to active (the active one ended). */
  const promoteFromJar = async (c: Context<AppEnv>): Promise<string | null> => {
    const jar = await liveJar(c);
    for (const [i, entry] of jar.entries()) {
      if (!(await isEligible(entry.userId))) continue;
      await sessions.touchExpiry(entry.token, Date.now() + TTL_MS);
      write(
        c,
        entry.token,
        jar.filter((_, j) => j !== i).map((e) => e.token),
      );
      return entry.userId;
    }
    write(c, undefined, []);
    return null;
  };

  const auditRevoke = (c: Context<AppEnv>, actorId: string) =>
    audit?.recordAudit({ action: "session_revoke", actorId, ip: c.get("clientIp") });

  return {
    async issue(c, userId) {
      // Keep the account that was active (if it's a different, still-live one) by
      // moving it to the front of the jar. Any older session of the account now
      // signing in is retired so one browser never holds two for the same user.
      const { active } = state(c);
      const previousUserId = await liveUserId(active);
      const kept: string[] = [];
      if (active && previousUserId) {
        if (previousUserId === userId) await sessions.revokeByToken(active);
        else kept.push(active);
      }
      for (const entry of await liveJar(c)) {
        if (entry.userId === userId) await sessions.revokeByToken(entry.token);
        else kept.push(entry.token);
      }
      // Over the cap, the least recently used account is signed out properly
      // (revoked), not just forgotten by the browser.
      for (const evicted of kept.splice(MAX_OTHER_ACCOUNTS)) {
        await sessions.revokeByToken(evicted);
      }

      const token = generateSessionToken();
      await sessions.create({
        userId,
        token,
        expiresAt: Date.now() + TTL_MS,
        ip: c.get("clientIp") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
      });
      write(c, token, kept);
      audit?.recordAudit({ action: "session_create", actorId: userId, ip: c.get("clientIp") });
    },

    async resolveUserId(c) {
      const st = state(c);
      if (!st.active) return null;
      const userId = await liveUserId(st.active);
      if (!userId) {
        // The active account ended (expired / revoked elsewhere). Fall back to
        // another account this browser is still signed in to, if any. Only ever
        // from a jar bound to that (former) active session — never a bare jar.
        return st.jar.length > 0 ? promoteFromJar(c) : null;
      }
      await sessions.touchExpiry(st.active, Date.now() + TTL_MS);
      setCookie(c, SESSION_COOKIE, st.active, { ...cookie(), maxAge });
      return userId;
    },

    async otherAccounts(c) {
      const activeUserId = await liveUserId(state(c).active);
      const seen = new Set(activeUserId ? [activeUserId] : []);
      const out: SignedInAccount[] = [];
      for (const entry of await liveJar(c)) {
        if (seen.has(entry.userId)) continue;
        seen.add(entry.userId);
        if (await isEligible(entry.userId)) out.push({ userId: entry.userId });
      }
      return out;
    },

    async switchTo(c, userId) {
      const jar = await liveJar(c);
      const target = jar.find((e) => e.userId === userId);
      if (!target || !(await isEligible(userId))) return false;
      const { active } = state(c);
      const activeUserId = await liveUserId(active);
      const rest = jar.filter((e) => e !== target).map((e) => e.token);
      // The account being switched away from becomes the most recently used one.
      const nextJar = active && activeUserId && activeUserId !== userId ? [active, ...rest] : rest;
      await sessions.touchExpiry(target.token, Date.now() + TTL_MS);
      write(c, target.token, nextJar);
      audit?.recordAudit({ action: "session_switch", actorId: userId, ip: c.get("clientIp") });
      return true;
    },

    async revoke(c) {
      const st = state(c);
      if (st.active) {
        // Resolve the owner before revoking so the audit row is attributed.
        const userId = await liveUserId(st.active);
        await sessions.revokeByToken(st.active);
        if (userId) auditRevoke(c, userId);
      }
      if (st.jar.length > 0 && (await promoteFromJar(c))) return { remaining: true };
      write(c, undefined, []);
      return { remaining: false };
    },

    async revokeAll(c) {
      for (const entry of await liveJar(c)) {
        await sessions.revokeByToken(entry.token);
        auditRevoke(c, entry.userId);
      }
      const { active } = state(c);
      if (active) {
        const userId = await liveUserId(active);
        await sessions.revokeByToken(active);
        if (userId) auditRevoke(c, userId);
      }
      write(c, undefined, []);
    },

    async revokeHeld(c, userId) {
      const { active } = state(c);
      if (!active) return false;
      const jar = await liveJar(c);
      const held = jar.filter((e) => e.userId === userId);
      if (held.length === 0) return false;
      for (const entry of held) await sessions.revokeByToken(entry.token);
      auditRevoke(c, userId);
      write(
        c,
        active,
        jar.filter((e) => e.userId !== userId).map((e) => e.token),
      );
      return true;
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
