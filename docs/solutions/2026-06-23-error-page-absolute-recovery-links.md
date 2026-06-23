---
title: System error pages must build ABSOLUTE recovery links (a canvas-subdomain `/` is the canvas, not the dashboard)
type: bug
area: http
date: 2026-06-23
---

The branded 4xx/5xx pages (`apps/server/src/http/error-pages.ts`) rendered one
recovery action — "Open dashboard" — with `actionHref ?? "/"`. In **subdomain mode**
the error page is served on the canvas origin (`{slug}.{baseHost}`), so a relative
`/` resolves to the *canvas* root, never the dashboard (which lives at `config.baseUrl`,
a different host). For the common canvas errors (missing / no-home / unpublished /
access-denied — and access-denied is a deliberately identical 404, §12.0) the canvas
root is itself broken, so the button looped back to the same failing page. Path mode
hid the bug because everything shares one origin.

**Fix:** thread typed config onto the request context (`AppVariables.config`, set by an
early `app.use` in `app.ts`, before `errorPageMiddleware`) and compute a `recoveryContext`
at render time: an ABSOLUTE `appBase` from `config.baseUrl`, plus an identity footer
("Signed in as … · Sign out") and an absolute sign-in link carrying `returnTo`. Both the
direct `errorResponse` path and the JSON→HTML `errorPageMiddleware` rewrite pass it to
`renderErrorPage`.

Gotchas worth remembering:

- **`normalizeDetails` defaulted `actionHref` to `/`**, which masked the recovery-aware
  fallback when it was read from the normalized object. Read the *raw* `input.actionHref`
  for the default chain, not the normalized one. (Caught only because the dashboard-link
  test failed while the identity-footer tests on the same page passed — same `recovery`,
  different field source.)
- **No-leak parity (§12.0).** The identity footer must derive ONLY from the resolved
  `user` + auth mode + config — never from the access decision — so a genuine 404 and an
  access-denied 404 stay byte-identical. Regression test: render both and compare with the
  echoed request path normalized out (the path is the only legitimate difference).
- **Auth-mode gating mirrors the SPA.** Show sign-out only when `authMode !== "proxy"`
  (matches `UserMenu`'s `canSignOut`); offer app-owned sign-in only in `oidc`. Identity is
  knowable on a canvas subdomain because the session cookie is scoped to `.{baseHost}`
  (`auth/session.ts`), and `user` is gateway-set by the time the middleware post-processes.
- **Cross-origin = absolute everywhere.** Any link off a canvas subdomain (dashboard,
  `/auth/login`, `/auth/logout`) must be prefixed with the app base; the relative
  `loginUrl()` helper and the disabled page's "sign in to your dashboard" hint had the
  same latent bug.
- **Disabled page stays neutral** (`hideIdentity: true`): it's shown to anyone with the
  URL, so it must look identical to every visitor (no "Signed in as …"), while still
  getting the working absolute dashboard button.
