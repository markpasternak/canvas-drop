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
        const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
          pkceCodeVerifier: tx.verifier,
          expectedState: tx.state,
        });
        claims = tokens.claims() as Record<string, unknown> | undefined;
      } catch {
        return c.json({ error: "token_exchange_failed" }, 400);
      }

      const identity = claims ? claimsToIdentity(claims, "oidc") : null;
      if (!identity) return c.json({ error: "no_email_claim" }, 400);
      return completeLogin(deps, c, identity);
    },
  };
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
