import type { Config } from "@canvas-drop/shared";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as client from "openid-client";
import type { AllowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import type { UsersRepository } from "../db/repositories/users.js";
import { errorResponse } from "../http/error-pages.js";
import type { AppEnv } from "../http/types.js";
import { claimsToIdentity, isEmailAllowed, mapIdentityToUser } from "./identity-mapping.js";
import { loginUrl, safeReturnTo } from "./return-to.js";
import type { SessionService } from "./session.js";
import type { ResolvedIdentity } from "./strategy.js";

/** Short-lived cookie carrying the PKCE verifier + state (+ returnTo) across the redirect. */
const OIDC_TX_COOKIE = "__canvasdrop_oidc";

/**
 * Cookie options for the short-lived OIDC transaction cookie. In `subdomain` mode
 * login can begin on a canvas subdomain (`<slug>.{host}`) while the callback runs
 * on the apex (the `redirect_uri` is built from `baseUrl`), so the cookie MUST be
 * scoped to the parent domain — a host-only cookie set on the subdomain is invisible
 * at the apex callback, which surfaces as `missing_oidc_state` or (with a stale apex
 * cookie) `state_mismatch`. Mirrors the session/guest cookies (session.ts, guest.ts).
 */
function txCookieOptions(config: Config) {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "Lax" as const,
    path: "/",
    ...(config.urlMode === "subdomain" ? { domain: `.${new URL(config.baseUrl).hostname}` } : {}),
  };
}

/**
 * A recoverable sign-in failure (stale/missing transaction, token exchange hiccup):
 * render a friendly page whose action restarts login — carrying the returnTo when we
 * still have it — instead of dead-ending the visitor on a raw error. Falls back to
 * JSON for non-browser clients via the shared error-page seam.
 */
function recoverableAuthError(
  c: Context<AppEnv>,
  config: Config,
  code: string,
  message: string,
  returnTo?: string,
) {
  return errorResponse(
    c,
    {
      status: 400,
      code,
      title: "Sign-in didn't finish",
      message,
      actionHref: loginUrl(config, returnTo),
      actionLabel: "Try signing in again",
    },
    { error: code },
  );
}

export interface OidcDeps {
  config: Config;
  users: UsersRepository;
  /** Admin-managed individual email allowlist (D14 supplement to the env domains). */
  allowedEmails: Pick<AllowedEmailsRepository, "isAllowed">;
  sessionSvc: SessionService;
  /** Lazily-resolved, discovery-cached openid-client configuration. */
  getConfig: () => Promise<client.Configuration>;
}

/**
 * Build the openid-client configuration (discovery), caching only on SUCCESS.
 * A failed discovery (IdP unreachable, transient network error) must not be
 * cached — otherwise one hiccup at first login would permanently break OIDC for
 * the process lifetime. The next call retries.
 */
export function makeOidcConfigLoader(config: Config): () => Promise<client.Configuration> {
  let cached: Promise<client.Configuration> | undefined;
  const { issuer, clientId, clientSecret } = config.auth.oidc;
  return () => {
    if (cached) return cached;
    const pending = client
      .discovery(new URL(issuer as string), clientId as string, clientSecret as string)
      .catch((err) => {
        cached = undefined; // allow retry on the next call
        throw err;
      });
    cached = pending;
    return pending;
  };
}

export function makeOidc(deps: OidcDeps) {
  const redirectUri = new URL("/auth/callback", deps.config.baseUrl).toString();

  return {
    /** Begin login: PKCE + state, stash in a short cookie, redirect to the IdP. */
    async login(c: Context<AppEnv>) {
      const cfg = await deps.getConfig();
      const verifier = client.randomPKCECodeVerifier();
      const challenge = await client.calculatePKCECodeChallenge(verifier);
      const state = client.randomState();
      // Where to send the visitor after a successful sign-in. Validated here so the
      // (untrusted) query param can't become an open redirect; it rides the tx
      // cookie across to the callback.
      const returnTo = safeReturnTo(deps.config, c.req.query("returnTo"));
      const url = client.buildAuthorizationUrl(cfg, {
        redirect_uri: redirectUri,
        scope: "openid email profile",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        // Force the IdP to re-prompt rather than silently re-authenticating via
        // its own SSO session. Our /auth/logout only revokes the local app
        // session — without this, clicking "sign out" then "sign in" bounces the
        // user straight back in with no prompt, which reads as a broken logout.
        // This keeps logout a local concern (we never end the IdP session) while
        // making re-login a deliberate act. Sessions are sliding-14-day, so the
        // extra prompt is rare.
        prompt: "login",
      });
      setCookie(
        c,
        OIDC_TX_COOKIE,
        JSON.stringify({ state, verifier, ...(returnTo ? { returnTo } : {}) }),
        { ...txCookieOptions(deps.config), maxAge: 600 },
      );
      return c.redirect(url.href);
    },

    /** Complete login: verify state, exchange code, establish the app session. */
    async callback(c: Context<AppEnv>) {
      const tx = readTx(c);
      deleteCookie(c, OIDC_TX_COOKIE, txCookieOptions(deps.config));
      if (!tx) {
        return recoverableAuthError(
          c,
          deps.config,
          "missing_oidc_state",
          "This sign-in link expired or was already used. Start again and we'll take you where you were headed.",
        );
      }

      const currentUrl = new URL(c.req.url);
      const stateParam = currentUrl.searchParams.get("state");
      if (!stateParam || stateParam !== tx.state) {
        return recoverableAuthError(
          c,
          deps.config,
          "state_mismatch",
          "Your sign-in didn't match this browser's request. Start over and we'll take you where you were going.",
          tx.returnTo,
        );
      }

      let claims: Record<string, unknown> | undefined;
      try {
        const cfg = await deps.getConfig();
        // Behind a TLS-terminating proxy the inbound request is plain http on an
        // internal host, so currentUrl (from c.req.url) has the wrong scheme/
        // origin. The token exchange's redirect_uri MUST byte-match the one sent
        // in the auth request (built from baseUrl) — rebuild it from baseUrl and
        // carry over the IdP response query params.
        const exchangeUrl = callbackUrl(deps.config.baseUrl, currentUrl);
        const tokens = await client.authorizationCodeGrant(cfg, exchangeUrl, {
          pkceCodeVerifier: tx.verifier,
          expectedState: tx.state,
        });
        claims = tokens.claims() as Record<string, unknown> | undefined;
      } catch (err) {
        c.get("log")?.error({ err }, "oidc token exchange failed");
        return recoverableAuthError(
          c,
          deps.config,
          "token_exchange_failed",
          "We couldn't complete sign-in with your identity provider. Please try again.",
          tx.returnTo,
        );
      }

      const identity = claims ? claimsToIdentity(claims, "oidc") : null;
      if (!identity) return c.json({ error: "no_email_claim" }, 400);
      // Defense-in-depth: never trust an email the IdP explicitly says it did not
      // verify (a permissive provider could let a user self-assert an allowlisted
      // address).
      if (claims && emailExplicitlyUnverified(claims)) {
        c.get("log")?.warn({ email: identity.email }, "oidc email not verified");
        return c.json({ error: "email_not_verified" }, 403);
      }
      return completeLogin(deps, c, identity, tx.returnTo);
    },
  };
}

/**
 * Whether the IdP explicitly marked the email claim as NOT verified. We reject
 * only this case — an absent `email_verified` claim is tolerated so conformant
 * IdPs that omit it still work. Accepts both the boolean and the string forms
 * (`false` / `"false"`) some providers emit.
 */
export function emailExplicitlyUnverified(claims: Record<string, unknown>): boolean {
  return claims.email_verified === false || claims.email_verified === "false";
}

/**
 * Reconstruct the OIDC callback URL from the configured base URL, carrying over
 * the IdP's response query params (code/state/iss). This is the redirect_uri the
 * token exchange sends to the IdP, and it MUST byte-match the one used in the auth
 * request — which is built from `baseUrl`. Using the raw request URL instead would
 * leak the proxy's internal scheme/host (e.g. http://localhost:3000) and the
 * exchange would fail. See the proxy/subdomain deployment notes.
 */
export function callbackUrl(baseUrl: string, requestUrl: URL | string): URL {
  const url = new URL("/auth/callback", baseUrl);
  url.search = new URL(requestUrl).search;
  return url;
}

/**
 * Shared post-authentication logic (also the testable security seam): enforce
 * the email-domain allowlist, upsert the user, reject blocked users, mint the
 * session.
 */
export async function completeLogin(
  deps: OidcDeps,
  c: Context<AppEnv>,
  identity: ResolvedIdentity,
  returnTo?: string,
) {
  if (!(await isEmailAllowed(identity.email, deps.config, deps.allowedEmails))) {
    return c.json({ error: "email_domain_not_allowed" }, 403);
  }
  const user = await mapIdentityToUser(deps.users, identity, deps.config);
  if (user.isBlocked) return c.json({ error: "forbidden" }, 403);
  await deps.sessionSvc.issue(c, user.id);
  // Re-validate at the seam: the tx cookie is httpOnly but unsigned, so never trust
  // its returnTo without re-checking it can't escape this instance (defense in depth).
  return c.redirect(safeReturnTo(deps.config, returnTo) ?? "/");
}

function readTx(c: Context<AppEnv>): { state: string; verifier: string; returnTo?: string } | null {
  const raw = getCookie(c, OIDC_TX_COOKIE);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { state?: unknown; verifier?: unknown; returnTo?: unknown };
    if (typeof v.state === "string" && typeof v.verifier === "string") {
      return {
        state: v.state,
        verifier: v.verifier,
        returnTo: typeof v.returnTo === "string" ? v.returnTo : undefined,
      };
    }
  } catch {
    // malformed cookie → treat as no transaction
  }
  return null;
}
