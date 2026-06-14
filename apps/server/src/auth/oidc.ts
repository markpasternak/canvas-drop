import type { Config } from "@canvas-drop/shared";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as client from "openid-client";
import type { UsersRepository } from "../db/repositories/users.js";
import type { AppEnv } from "../http/types.js";
import { claimsToIdentity, isEmailDomainAllowed, mapIdentityToUser } from "./identity-mapping.js";
import type { SessionService } from "./session.js";
import type { ResolvedIdentity } from "./strategy.js";

/** Short-lived cookie carrying the PKCE verifier + state across the redirect. */
const OIDC_TX_COOKIE = "__canvasdrop_oidc";

export interface OidcDeps {
  config: Config;
  users: UsersRepository;
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
      setCookie(c, OIDC_TX_COOKIE, JSON.stringify({ state, verifier }), {
        httpOnly: true,
        secure: deps.config.isProduction,
        sameSite: "Lax",
        path: "/",
        maxAge: 600,
      });
      return c.redirect(url.href);
    },

    /** Complete login: verify state, exchange code, establish the app session. */
    async callback(c: Context<AppEnv>) {
      const tx = readTx(c);
      deleteCookie(c, OIDC_TX_COOKIE, { path: "/" });
      if (!tx) return c.json({ error: "missing_oidc_state" }, 400);

      const currentUrl = new URL(c.req.url);
      const stateParam = currentUrl.searchParams.get("state");
      if (!stateParam || stateParam !== tx.state) {
        return c.json({ error: "state_mismatch" }, 400);
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
        return c.json({ error: "token_exchange_failed" }, 400);
      }

      const identity = claims ? claimsToIdentity(claims, "oidc") : null;
      if (!identity) return c.json({ error: "no_email_claim" }, 400);
      return completeLogin(deps, c, identity);
    },
  };
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
) {
  if (!isEmailDomainAllowed(identity.email, deps.config)) {
    return c.json({ error: "email_domain_not_allowed" }, 403);
  }
  const user = await mapIdentityToUser(deps.users, identity, deps.config);
  if (user.isBlocked) return c.json({ error: "forbidden" }, 403);
  await deps.sessionSvc.issue(c, user.id);
  return c.redirect("/");
}

function readTx(c: Context<AppEnv>): { state: string; verifier: string } | null {
  const raw = getCookie(c, OIDC_TX_COOKIE);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { state?: unknown; verifier?: unknown };
    if (typeof v.state === "string" && typeof v.verifier === "string") {
      return { state: v.state, verifier: v.verifier };
    }
  } catch {
    // malformed cookie → treat as no transaction
  }
  return null;
}
