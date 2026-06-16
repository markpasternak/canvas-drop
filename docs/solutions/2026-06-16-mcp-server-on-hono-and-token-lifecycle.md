---
title: Building the agent MCP server on Hono — @hono/mcp, a thin in-app OAuth AS, and the token-lifecycle invariant
type: architecture
area: auth
date: 2026-06-16
---

How canvas-drop got a remote **MCP server** (OAuth 2.1 + an 8-tool surface) onto its
Hono app without an Express bridge, why it is its *own* authorization server rather
than a proxy, and the §12.0 invariant a `/ce-code-review` caught that self-review
missed. Read before touching `apps/server/src/mcp/*` or adding any second
token-issuing auth surface. See also [[2026-06-13-auth-invariant-checklist]],
[[dual-dialect-drizzle-seam]], [[2026-06-16-oidc-subdomain-cookie-and-returnto]].

## MCP on a Hono app = `@hono/mcp`, not the SDK's Express router

The official `@modelcontextprotocol/sdk` ships its auth router and transports as
**Express** (`mcpAuthRouter` returns an Express router; `OAuthServerProvider.authorize`
is typed `(client, params, res: express.Response)`; `StreamableHTTPServerTransport`
speaks Node `http`). Bridging Express into Hono is the wrong move.

**`@hono/mcp` (v0.3) is the Hono-native port.** It re-exports the same SDK provider
*model* but provides Hono-native wiring:

- `mcpAuthRouter(...)` returns a `Hono` sub-app (authorize / token / register-DCR /
  revoke + RFC 8414 / 9728 metadata). Mount it at root so `.well-known/*` resolves.
- `StreamableHTTPTransport` — `transport.handleRequest(c)` takes the Hono `Context`.
- `bearerAuth`, `createOAuthMetadata`, a Hono `ProxyOAuthServerProvider`.
- Its provider's `authorize(client, params, c)` receives a **Hono `Context`**, not an
  Express `Response`.

**The `implements OAuthServerProvider` trick:** our `McpOAuthProvider` declares
`authorize(client, params, c: Context)` yet satisfies the SDK interface (typed with
Express `Response`) because TypeScript checks **method** parameters bivariantly — the
exact mechanism `@hono/mcp`'s own `ProxyOAuthServerProvider` relies on. Keep
`authorize` a method (not an arrow-function property) or the bivariance hole closes
and it won't compile.

**`@hono/mcp` rate-limits its OAuth endpoints by default** (authorize 100/15m, token
50/15m, DCR register 20/h) — don't add redundant throttling there; a reviewer flagged
"unthrottled AS endpoints" not knowing the library default.

## Be your own thin authorization server, not a proxy

`ProxyOAuthServerProvider` would delegate the whole OAuth dance to the upstream IdP —
but Google (the prod IdP) has **no Dynamic Client Registration**, so a pure proxy
breaks for the most likely deployment. Instead canvas-drop *is* the AS and reuses its
own login as the authenticate step:

- `authorize` resolves identity with the **same** `strategy.resolveIdentity(c)` the
  gateway uses. On a miss in `oidc` mode it `c.res = c.redirect(loginUrl(config,
  requestReturnTo(...)))` — the user goes through the normal org login and the browser
  returns to `/authorize` with a session, which resumes the flow. `dev`/`proxy`
  auto-resolve, so a miss there is a hard `AccessDeniedError`.
- Codes and tokens reuse `hashToken` / `generateSessionToken` (hash-at-rest) and live
  in three dual-dialect tables (`oauth_clients` / `oauth_codes` / `mcp_tokens`).
- Auth codes are single-use via an **atomic** conditional `UPDATE … WHERE consumed_at
  IS NULL … RETURNING` (`codes.consume`). Refresh rotation needs the *same* atomicity
  (`tokens.consume`) — a find-then-revoke rotate double-mints under concurrency.
- The SDK's token handler does PKCE itself (verify `code_verifier` against the
  `challengeForAuthorizationCode` return) as long as `skipLocalPkceValidation` is
  falsy — so the provider's `exchangeAuthorizationCode` ignores the verifier. If anyone
  ever swaps in the proxy provider (`skipLocalPkceValidation=true`), PKCE silently
  moves upstream — don't.

## The §12.0 invariant the review caught: token surfaces must honor lifecycle

Self-review + green tests shipped a **P0** that three review personas converged on: a
**second token-issuing auth surface must re-check the account on every use, exactly
like the gateway does** — and revoke on block.

The session gateway re-checks `isBlocked` and the email allowlist on *every request*
(`auth/gateway.ts`). The first cut of the MCP surface did not: `verifyAccessToken` and
`exchangeRefreshToken` trusted only the token row's `userId`. Result: a user blocked
(or de-allowlisted) **after** issuing an MCP token kept full agent access for the
access-token TTL (1 h) and **indefinitely** via the self-rotating refresh token. The
lifecycle revocation that protects every other surface had no equivalent.

The fix is two-layer (do both):

1. **Re-validate on use.** `verifyAccessToken` *and* `exchangeRefreshToken` re-load the
   user and reject blocked / deleted / de-allowlisted (`assertUserActive`). This makes
   the block honored on the *next* call, matching the gateway — the robust invariant fix.
2. **Revoke on block.** Wire `oauth.tokens.revokeAllForUser(id)` into the admin block
   handler so live tokens die instantly and the refresh chain is cut (defense in depth;
   the unused `revokeAllForUser` was the tell that this was missing).

**Test block-AFTER-issue, not just block-at-authorize.** The original tests only blocked
a user *before* authorize (no token yet) and passed — the gap was invisible. The
regression test issues a token, blocks the user, then asserts `verifyAccessToken`, a
`/mcp` tool call, *and* `exchangeRefreshToken` all refuse. Same shape for allowlist
removal.

**Checklist for any new token-issuing surface:** does blocking a user / removing their
allowlist entry kill a *live* token within one request? If not, it's a §12.0 escape.

## Smaller traps

- **A custom `app.onError` that returns 500 for everything flattens `HTTPException`.**
  Hono's default error handler honors `HTTPException.getResponse()`, but a catch-all
  `onError` does not. The transport throws `HTTPException` for protocol faults (bad
  Accept / Content-Type / unparseable body); catch it at the `/mcp` route and return
  `e.getResponse()` so clients get the JSON-RPC error, not an opaque 500. The bearer
  guard returns 401 *directly* (not via throw) for the same reason.
- **`Buffer.from(str, "base64")` never throws** — it silently drops invalid chars. A
  `try/catch` around it is dead code; guard on `byteLength === 0` and let the downstream
  `DeployError` handle malformed input.
- **Config-gated mount = not mounted, not 403.** When `CANVAS_DROP_MCP=off`, the whole
  `mcpRoutes` sub-app is never mounted (mirrors how proxy mode declines to mount the
  guest resolver). The SPA catch-all may still answer `/.well-known/...` with HTML, so
  test "the surface is absent" by asserting the body is *not* the OAuth metadata JSON,
  not by asserting a literal 404.
- **Verify SDK behaviour against the installed `.d.ts`, not memory.** The whole
  Express-vs-Hono question was settled in ~20 min by `npm install`-ing `@hono/mcp` into
  a temp dir and reading its shipped types — far faster than guessing from blog posts.
