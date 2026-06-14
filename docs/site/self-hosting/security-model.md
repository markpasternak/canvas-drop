# Security model

canvas-drop hosts arbitrary, sometimes AI-generated, web artifacts for a trusted
organization. The model is honest about what each mode guarantees.

## Identity is always server-side

Identity comes from the server-side auth context, never from the client. In
`proxy` mode only the trusted proxy may assert identity — verified by JWT, or by
trusting headers solely from `CANVAS_DROP_TRUSTED_PROXY_IPS`. A canvas can *ask*
for a capability; the server decides per request.

## No secrets in the browser

AI provider keys and canvas API keys are server-side only. Canvas files never
contain a key. The browser SDK rides the session cookie.

## Path mode vs subdomain mode

This is the most important deployment choice:

- **Path mode** (`{base}/c/{slug}`) — all canvases share one origin with each
  other and with the dashboard. A malicious or XSS'd canvas could issue
  same-origin requests toward other canvases' client-side state. **Fine for
  localhost and trusted single-user hosting.** Multi-user path mode must be opted
  into explicitly (`CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE=true`) and shows an
  admin warning.
- **Subdomain mode** (`{slug}.{base}`) — each canvas is its own origin, so the
  browser isolates them. **This is the blessed production profile**, fronted by an
  identity-aware proxy with wildcard TLS.

## Fronting with an identity-aware proxy

The blessed production setup is subdomain mode + a proxy that handles auth (JWT)
and TLS. If you don't run such a proxy, the built-in `oidc` mode is the documented
fallback so you're never forced to stand one up just to try the product.

## Reducing canvas XSS blast radius

Subdomain mode contains the blast radius of a compromised canvas; private-by-
default limits exposure. Canvas authors should prefer `textContent` over
`innerHTML`.
