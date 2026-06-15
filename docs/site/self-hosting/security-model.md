# Security model

canvas-drop hosts arbitrary, sometimes AI-generated, web artifacts for a trusted
organization — everyone has already passed SSO and the email-domain allowlist.
It is not built to defend against the hostile internet. Inside that trust
boundary it holds five hard invariants; beyond them it stays simple and
permissive. This page tells you, as an operator, where the boundary is and how
your config decisions keep it intact.

## The trust boundary

A request only becomes a *user* after the auth gateway resolves a server-side
identity, checks the email allowlist (the env domain list **or** an admin-managed
list of individual emails), maps it to a user, and rejects blocked users. Identity
always comes from the server-side strategy — never from anything the client sends.
Pick the strategy with `CANVAS_DROP_AUTH_MODE`:

- `dev` — auto-logs-in a fixed local user, no external verification. Localhost
  only; a stub for trying the product.
- `proxy` — an identity-aware reverse proxy in front of the app asserts identity.
  This is the production profile when you run such a proxy.
- `oidc` — the app runs the OIDC Authorization-Code + PKCE flow itself and owns
  the session. The built-in fallback when you don't front it with a proxy, so
  you're never forced to stand up a proxy just to try it.

Mode is a config swap, not a code change. See
[configuration](./configuration.md) for the full setup of each.

## The five hard invariants

These are the guarantees the platform upholds (`BUILD_BRIEF.md` §12.0):

1. **No impersonation.** A user is always who the resolved identity says they
   are. Identity (`me()`, write attribution, presence) comes from the
   server-side auth context, never from the client.
2. **No credential or canvas theft.** No user can read another user's session,
   canvas API key, or canvas content. API keys and session tokens are
   SHA-256-hashed at rest (only the hash is stored); API keys are shown once at
   creation, and session tokens live only in an HttpOnly cookie.
3. **No unauthorized access.** A canvas is reachable only by its owner/admin; at
   the `whole_org` rung, allowed org members; at `specific_people`, a principal on
   its allowlist (an org member, or an invited guest whose magic-link session is
   for *that* canvas); at `public_link`, anyone — but static-only and only while
   the owner account holds the admin-granted publish capability. All subject to
   not revoked/expired and any password. Everything else returns `404`; a guest
   can never reach a canvas it wasn't invited to, and an anonymous public visitor
   gets no backend primitives.
4. **No cross-canvas reach in subdomain mode.** One canvas (or its code, SDK, or
   socket) cannot read, write, or act on another canvas's data, files, AI quota,
   or realtime channels. Path mode has reduced browser isolation (see below).
5. **Lifecycle is honored instantly.** Revoke, expiry, disable, delete, slug
   regen, key regen, rung lowering, allowlist removal, guest-invite revocation,
   and unpublish take effect on the next request and drop live realtime sockets
   (guest sockets included) — no stale grants. A guest session never outlives its
   invite's expiry or revocation.

## Identity is always server-side (invariant #1)

In `proxy` mode exactly one trust path is active, chosen by config — they do not
compose, so an attacker can't omit the JWT to downgrade to the weaker path:

- **JWKS / JWT path (preferred, cryptographic).** When you configure a JWKS URL,
  identity comes only from the proxy's signed JWT, verified against the
  configured issuer and audience. The identity header is never honored in this
  mode; a stray identity header with no valid JWT resolves to anonymous and is
  logged as a downgrade probe.
- **Trusted-header path (only when no JWKS is configured).** The forwarded email
  header is trusted only when the request's immediate hop is in
  `CANVAS_DROP_TRUSTED_PROXY_IPS`. The check gates on the socket peer IP, never
  on a client-influenced `X-Forwarded-For` value. `/0` is rejected, so "trust
  every source" is impossible by construction. A header from an untrusted source
  is ignored and logged.

Proxy mode refuses to start without either a JWKS URL or a trusted-proxy IP set,
and the app must never be directly reachable — only through the proxy, which
overwrites (not appends) the identity headers.

In `oidc` mode the app mints its own session: the `__canvasdrop_session` cookie
holds a SHA-256-hashed high-entropy token, HttpOnly, Secure in prod,
SameSite=Lax, 14-day rolling expiry; subdomain mode scopes it to `.{baseHost}`.

## No secrets in the browser (invariant #2)

AI provider keys and canvas API keys are server-side only. Canvas files never
contain a key — the deploy engine even lints uploads and warns when a file may
contain a canvas API key. The browser SDK rides the session, so canvases call
the primitives (KV, files, AI, identity, realtime) without secrets in code.

Deploy API keys are `cd_…` Bearer secrets, hashed at rest and shown once. A key
operates only on its own canvas. See [the deploy API](../api/deploy-api.md).

## Path mode vs subdomain mode (invariant #4)

This is the most consequential deployment choice (`CANVAS_DROP_URL_MODE`):

- **Path mode** (`{base}/c/{slug}`) — every canvas shares one origin with the
  others and with the dashboard, so the browser does not isolate them. A
  malicious or XSS'd canvas could make same-origin requests against other
  canvases' client-side state. Fine for localhost and trusted single-user
  hosting. Multi-user path mode must be opted into explicitly with
  `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE=true` and surfaces an admin warning.
- **Subdomain mode** (`{slug}.{base}`) — each canvas is its own origin, so the
  browser isolates them and invariant #4 holds. This is the production profile,
  fronted by an identity-aware proxy with wildcard TLS.

If you don't run an identity-aware proxy, run subdomain mode with `oidc` so you
keep per-canvas origin isolation without standing up a proxy.

## Reducing canvas XSS blast radius

Subdomain mode contains the blast radius of a compromised canvas; private-by-
default limits exposure. Tell canvas authors to prefer `textContent` over
`innerHTML`.

## No telemetry

canvas-drop does not phone home. There is no analytics or usage reporting in the
product — nothing leaves your instance unless you configure an outbound
integration (e.g. an OIDC provider or AI provider) yourself.
