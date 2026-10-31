import type { Config } from "@canvas-drop/shared";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Context } from "hono";
import { isEmailAllowed, mapIdentityToUser } from "../auth/identity-mapping.js";
import { loginUrl, requestReturnTo } from "../auth/return-to.js";
import type { AuthStrategy } from "../auth/strategy.js";
import type { AllowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import type { OauthRepository } from "../db/repositories/oauth.js";
import { generateSessionToken } from "../db/repositories/sessions.js";
import type { UsersRepository } from "../db/repositories/users.js";
import { isSameOrigin } from "../http/same-origin.js";
import type { AppEnv } from "../http/types.js";
import {
  CONSENT_HEADERS,
  CONSENT_PARAM,
  carriedParams,
  renderConsentPage,
  signConsent,
  verifyConsent,
} from "./consent.js";

/** Authorization codes are single-use and short-lived (defense against replay). */
const CODE_TTL_MS = 60_000;
/** Access tokens expire in an hour; refresh tokens rotate on use. */
const ACCESS_TTL_MS = 60 * 60 * 1000;

/** A minimal audit hook so the provider stays decoupled from the audit sink (U6). */
export interface McpAuditSink {
  record(event: { action: string; actorId?: string; ip?: string; reason?: string }): void;
}

export interface McpOAuthProviderDeps {
  config: Config;
  strategy: AuthStrategy;
  users: UsersRepository;
  allowedEmails: Pick<AllowedEmailsRepository, "isAllowed">;
  oauth: OauthRepository;
  audit?: McpAuditSink;
}

/**
 * The canvas-drop MCP OAuth authorization server (U3). canvas-drop is its *own*
 * thin authorization server — not a proxy — because Google (the common prod IdP)
 * has no Dynamic Client Registration. The protocol, DCR, PKCE, and metadata are
 * `@hono/mcp`'s job; this class supplies only the identity bridge and token store.
 *
 * Invariants (§12.0, see docs/solutions/2026-06-13-auth-invariant-checklist.md):
 *  - Identity comes only from the server-side auth strategy (the same one the
 *    gateway uses), never from anything the client sends.
 *  - The email-domain allowlist is enforced before any token is issued.
 *  - Codes are single-use (atomic consume) and tokens are hashed at rest.
 *
 * `authorize` takes a Hono `Context` (the `@hono/mcp` provider shape); the SDK's
 * interface types it as an Express `Response`, but method parameter bivariance
 * lets this satisfy `implements OAuthServerProvider`, exactly as `@hono/mcp`'s own
 * `ProxyOAuthServerProvider` does.
 */
export class McpOAuthProvider implements OAuthServerProvider {
  constructor(private readonly deps: McpOAuthProviderDeps) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    const { oauth } = this.deps;
    return {
      getClient: (clientId) => oauth.clients.get(clientId),
      // DCR: the router pre-generates client_id; we persist the full registration.
      registerClient: (client) => oauth.clients.upsert(client as OAuthClientInformationFull),
    };
  }

  /**
   * The login gate. Resolve identity via the same server-side strategy the auth
   * gateway uses. If absent (oidc, signed out), bounce to the existing login
   * carrying returnTo=this authorize URL so the browser returns here with a
   * session and the flow resumes — no second IdP, no pasted secret. On success,
   * mint a single-use code bound to the resolved user and redirect to the client.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    c: Context<AppEnv>,
  ): Promise<void> {
    const { config, strategy, users, allowedEmails, oauth, audit } = this.deps;
    const ip = c.get("clientIp");

    const identity = await strategy.resolveIdentity(c);
    if (!identity) {
      // oidc owns login: send them through it and come back to this exact URL.
      // proxy/dev always resolve an identity, so a miss there is a hard denial.
      if (config.auth.mode === "oidc") {
        const returnTo = requestReturnTo(config, c.req.header("host"), c.req.url);
        c.res = c.redirect(loginUrl(config, returnTo));
        return;
      }
      audit?.record({ action: "mcp_authorize_denied", reason: "no_identity", ip });
      throw new AccessDeniedError("not authenticated");
    }

    if (!(await isEmailAllowed(identity.email, config, allowedEmails))) {
      audit?.record({
        action: "mcp_authorize_denied",
        reason: "domain_not_allowed",
        ip,
      });
      throw new AccessDeniedError("email not allowed");
    }

    const user = await mapIdentityToUser(users, identity, config);
    if (user.isBlocked) {
      audit?.record({ action: "mcp_authorize_denied", reason: "blocked", actorId: user.id, ip });
      throw new AccessDeniedError("user is blocked");
    }

    // Consent: the member must have approved this client — now, on the consent page,
    // or before (a live grant they haven't revoked). Signing in alone never delegates.
    const binding = {
      userId: user.id,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
    };
    const approved =
      verifyConsent(config.sessionSecret, binding, c.req.query(CONSENT_PARAM)) ||
      (await oauth.tokens.hasLiveGrant(user.id, client.client_id));
    if (!approved) {
      audit?.record({ action: "mcp_authorize_consent_prompt", actorId: user.id, ip });
      c.res = new Response(
        renderConsentPage({
          client,
          redirectUri: params.redirectUri,
          accountEmail: user.email,
          params: carriedParams(new URL(c.req.url).searchParams),
        }),
        { status: 200, headers: CONSENT_HEADERS },
      );
      return;
    }

    const code = generateSessionToken();
    await oauth.codes.create({
      code,
      clientId: client.client_id,
      userId: user.id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: "S256",
      scopes: params.scopes ?? null,
      resource: params.resource?.href ?? null,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    audit?.record({ action: "mcp_authorize_ok", actorId: user.id, ip });

    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code);
    if (params.state) redirect.searchParams.set("state", params.state);
    c.res = c.redirect(redirect.href);
  }

  /**
   * The consent form's POST (`/authorize/consent`). Same-origin only, identity from
   * the server-side strategy. Allow → back to `/authorize` with a bound approval;
   * Cancel → the client's registered redirect with `access_denied`.
   */
  async handleConsent(c: Context<AppEnv>): Promise<Response> {
    const { config, strategy, users, allowedEmails, oauth, audit } = this.deps;
    if (!isSameOrigin(c, config)) return c.json({ error: "forbidden" }, 403);
    const form = await c.req.parseBody();
    const fields = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) if (typeof v === "string") fields.set(k, v);
    const params = carriedParams(fields);
    const clientId = params.get("client_id");
    const redirectUri = params.get("redirect_uri");
    const codeChallenge = params.get("code_challenge");
    const client = clientId ? await oauth.clients.get(clientId) : undefined;
    if (!client || !redirectUri || !codeChallenge || !client.redirect_uris.includes(redirectUri)) {
      return c.json({ error: "invalid_request" }, 400);
    }

    if (fields.get("decision") !== "allow") {
      const back = new URL(redirectUri);
      back.searchParams.set("error", "access_denied");
      const state = params.get("state");
      if (state) back.searchParams.set("state", state);
      return c.redirect(back.href, 303);
    }

    const identity = await strategy.resolveIdentity(c);
    if (!identity || !(await isEmailAllowed(identity.email, config, allowedEmails))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const user = await mapIdentityToUser(users, identity, config);
    if (user.isBlocked) return c.json({ error: "forbidden" }, 403);

    params.set(
      CONSENT_PARAM,
      signConsent(config.sessionSecret, {
        userId: user.id,
        clientId: client.client_id,
        redirectUri,
        codeChallenge,
      }),
    );
    audit?.record({ action: "mcp_authorize_consent_ok", actorId: user.id, ip: c.get("clientIp") });
    return c.redirect(`/authorize?${params.toString()}`, 303);
  }

  /** Return the stored PKCE challenge so the token handler can verify the verifier. */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const row = await this.deps.oauth.codes.findLive(authorizationCode);
    if (!row) throw new InvalidGrantError("invalid or expired authorization code");
    return row.codeChallenge;
  }

  /** Consume the code (single-use) and mint a token pair bound to the code's user. */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const row = await this.deps.oauth.codes.consume(authorizationCode);
    if (!row) throw new InvalidGrantError("invalid or expired authorization code");
    if (row.clientId !== client.client_id) {
      throw new InvalidGrantError("authorization code was issued to a different client");
    }
    if (redirectUri !== undefined && redirectUri !== row.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return this.issueTokens(client.client_id, row.userId, asScopes(row.scopes));
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    // Atomic rotate: the conditional consume makes the presented refresh token
    // single-use even under concurrency (two simultaneous refreshes → one wins,
    // the other gets null), so one refresh token mints exactly one new pair.
    const row = await this.deps.oauth.tokens.consume(refreshToken, "refresh");
    if (!row) throw new InvalidGrantError("invalid or expired refresh token");
    if (row.clientId !== client.client_id) {
      throw new InvalidGrantError("refresh token was issued to a different client");
    }
    // Re-validate the user on rotation so a blocked/de-allowlisted account cannot
    // keep refreshing its way to fresh tokens (§12.0 lifecycle honored).
    await this.assertUserActive(row.userId, "grant");
    return this.issueTokens(client.client_id, row.userId, scopes ?? asScopes(row.scopes));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = await this.deps.oauth.tokens.findLive(token, "access");
    if (!row) throw new InvalidTokenError("invalid or expired access token");
    // Re-check the account on every call — a live token must never outlive the
    // user being blocked or losing allowlist access. The session gateway does the
    // same per-request (auth/gateway.ts); the agent surface must match it (§12.0).
    await this.assertUserActive(row.userId, "token");
    return {
      token,
      clientId: row.clientId,
      scopes: asScopes(row.scopes) ?? [],
      expiresAt: row.expiresAt ? Math.floor(row.expiresAt / 1000) : undefined,
      // The acting user — read by the bearer middleware and every tool.
      extra: { userId: row.userId },
    };
  }

  /**
   * Reject a token whose user has since been blocked, deleted, or removed from the
   * sign-in allowlist. Throws the grant-appropriate OAuth error so the surface honors
   * the same lifecycle the gateway enforces on every request.
   */
  private async assertUserActive(userId: string, ctx: "token" | "grant"): Promise<void> {
    const fail = (msg: string) => {
      throw ctx === "token" ? new InvalidTokenError(msg) : new InvalidGrantError(msg);
    };
    const user = await this.deps.users.findById(userId);
    if (!user || user.isBlocked) return fail("account is no longer active");
    if (!(await isEmailAllowed(user.email, this.deps.config, this.deps.allowedEmails))) {
      return fail("account is no longer allowed to sign in");
    }
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // Resolve the owner first so the audit row is attributed (best-effort).
    const row = await this.deps.oauth.tokens.findLive(request.token);
    await this.deps.oauth.tokens.revoke(request.token);
    this.deps.audit?.record({ action: "mcp_token_revoke", actorId: row?.userId });
  }

  private async issueTokens(
    clientId: string,
    userId: string,
    scopes: string[] | null,
  ): Promise<OAuthTokens> {
    const accessToken = generateSessionToken();
    const refreshToken = generateSessionToken();
    const now = Date.now();
    // Issue both rows together: a sequential pair leaves an orphaned access token if the
    // refresh insert fails (the caller retries and gets no tokens, so the dangling access
    // row accumulates). Promise.all isn't a transaction, but it removes the partial-commit
    // window's latency and keeps the two inserts a single logical step. (A true atomic
    // INSERT would need a transaction on the dual-dialect repo seam — see OauthRepository.)
    await Promise.all([
      this.deps.oauth.tokens.create({
        token: accessToken,
        kind: "access",
        clientId,
        userId,
        scopes,
        expiresAt: now + ACCESS_TTL_MS,
      }),
      this.deps.oauth.tokens.create({
        token: refreshToken,
        kind: "refresh",
        clientId,
        userId,
        scopes,
      }),
    ]);
    this.deps.audit?.record({ action: "mcp_token_issue", actorId: userId });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refreshToken,
      ...(scopes && scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
    };
  }
}

/** The `scopes` json column is `string[] | null`; narrow it for the SDK shapes. */
function asScopes(value: unknown): string[] | null {
  return Array.isArray(value) ? (value as string[]) : null;
}
