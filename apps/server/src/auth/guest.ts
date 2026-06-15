import type { Config } from "@canvas-drop/shared";
import type { GuestInvite } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { GuestRepository } from "../db/repositories/guest.js";
import { generateSessionToken, hashToken } from "../db/repositories/sessions.js";
import type { AppEnv, Principal } from "../http/types.js";

/** Guest session cookie (separate from the org `__canvasdrop_session`). */
export const GUEST_COOKIE = "__canvasdrop_guest";
/** Guest session rolling TTL — bounded by the invite's own expiry on every resolve. */
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** The guest principal for an invite (id namespaced so it never collides, KTD2). */
function guestPrincipal(invite: GuestInvite): Principal {
  return {
    kind: "guest",
    id: `guest:${invite.id}`,
    inviteId: invite.id,
    canvasId: invite.canvasId,
    email: invite.email,
  };
}

export interface GuestService {
  /** Mint an invite; returns the plaintext magic-link token (only the hash is stored). */
  createInvite(
    canvasId: string,
    email: string,
    expiresAt?: number | null,
  ): Promise<{ token: string; invite: GuestInvite }>;
  /** Consume a magic-link token: establish a guest session + cookie. Single-use. */
  consumeMagicLink(c: Context<AppEnv>, token: string): Promise<Principal | null>;
  /** Resolve the guest cookie to a principal, or null. Cross-checks the invite (R12). */
  resolveGuest(c: Context<AppEnv>): Promise<Principal | null>;
  /** Revoke a guest's invite + sessions for (canvas, email) — drops access next request. */
  revokeInvite(canvasId: string, email: string): Promise<void>;
  /** Revoke every guest invite + session for a canvas (unpublish/archive cleanup). */
  revokeAllForCanvas(canvasId: string): Promise<void>;
  /** Clear the guest cookie (sign-out / dead session). */
  clearCookie(c: Context<AppEnv>): void;
}

export function guestService(config: Config, guests: GuestRepository): GuestService {
  // Scoped exactly like the org session cookie (KTD8): subdomain mode shares it
  // across canvas subdomains (the decision table's canvasId check is what enforces
  // per-canvas scope, AE1); path mode is host-only.
  const cookie = () => ({
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "Lax" as const,
    path: "/",
    ...(config.urlMode === "subdomain" ? { domain: `.${new URL(config.baseUrl).hostname}` } : {}),
  });

  /** A session must never outlive its invite's expiry (R12). */
  const boundedExpiry = (inviteExpiresAt: number | null, now: number): number => {
    const rolling = now + SESSION_TTL_MS;
    return inviteExpiresAt === null ? rolling : Math.min(rolling, inviteExpiresAt);
  };

  return {
    async createInvite(canvasId, email, expiresAt) {
      const token = generateSessionToken();
      const invite = await guests.createInvite({
        canvasId,
        email,
        tokenHash: hashToken(token),
        expiresAt: expiresAt ?? null,
      });
      return { token, invite };
    },

    async consumeMagicLink(c, token) {
      const now = Date.now();
      const invite = await guests.findInviteByTokenHash(hashToken(token));
      // Single-use: only a pending invite consumes; revoked/already-active fail.
      if (invite?.state !== "pending") return null;
      if (invite.expiresAt !== null && invite.expiresAt <= now) return null;

      // Atomic single-use: only the consume that actually flips pending→active mints
      // a session; a concurrent second consume of the same token no-ops here.
      if (!(await guests.markConsumed(invite.id))) return null;
      const sessionToken = generateSessionToken();
      await guests.createSession({
        inviteId: invite.id,
        canvasId: invite.canvasId,
        tokenHash: hashToken(sessionToken),
        expiresAt: boundedExpiry(invite.expiresAt, now),
      });
      setCookie(c, GUEST_COOKIE, sessionToken, {
        ...cookie(),
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      });
      return guestPrincipal(invite);
    },

    async resolveGuest(c) {
      const token = getCookie(c, GUEST_COOKIE);
      if (!token) return null;
      const now = Date.now();
      const session = await guests.findLiveSessionByTokenHash(hashToken(token), now);
      if (!session) return null;
      // The session is bounded by its invite: a revoked or expired invite kills it
      // on the very next request, no cached grant (R12 / §12.0 #5).
      const invite = await guests.findInviteById(session.inviteId);
      if (!invite || invite.state === "revoked") return null;
      if (invite.expiresAt !== null && invite.expiresAt <= now) return null;

      const next = boundedExpiry(invite.expiresAt, now);
      await guests.touchSessionExpiry(hashToken(token), next);
      setCookie(c, GUEST_COOKIE, token, { ...cookie(), maxAge: Math.floor(SESSION_TTL_MS / 1000) });
      return guestPrincipal(invite);
    },

    revokeInvite(canvasId, email) {
      return guests.revokeInvite(canvasId, email);
    },

    revokeAllForCanvas(canvasId) {
      return guests.revokeAllForCanvas(canvasId);
    },

    clearCookie(c) {
      deleteCookie(c, GUEST_COOKIE, cookie());
    },
  };
}
