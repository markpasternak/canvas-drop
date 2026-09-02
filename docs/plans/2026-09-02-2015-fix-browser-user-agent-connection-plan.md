# Browser User-Agent connection fix

Issue: #96

## Goal

Let a Connections profile provide the controlled upstream `User-Agent` when a browser invokes the canvas runtime. Browsers add their own ambient `User-Agent` to the request even though canvas JavaScript cannot author that header, so it must not be treated as a caller override.

## Scope

- Strip the browser runtime's ambient `User-Agent` before handing caller headers to the outbound transport.
- Keep the transport's protected-header collision rule unchanged for explicit/non-browser callers.
- Add a route-level regression test proving the controlled profile header reaches the transport and the ambient browser header does not.
- Run the full local gates, review, CI, production deploy, and live LTIP verification.

## Acceptance

- A browser request with an ambient `User-Agent` succeeds against a profile that protects `User-Agent`.
- The outbound transport receives the admin-controlled value as a protected header.
- Direct transport callers still cannot override protected headers.
- The LTIP canvas loads live Nasdaq data through client-side JavaScript and the Connections primitive.
