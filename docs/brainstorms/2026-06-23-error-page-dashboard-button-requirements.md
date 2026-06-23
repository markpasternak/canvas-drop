---
date: 2026-06-23
topic: error-page-dashboard-button
---

# Error / 404 page recovery actions ("Open dashboard" is dead in subdomain mode)

## Summary

The branded system error page (`apps/server/src/http/error-pages.ts`) renders a single
recovery action — a button labelled **"Open dashboard"** whose href defaults to **`/`**. On a
canvas **subdomain** (`{slug}.{baseHost}`), `/` is the *canvas's own root*, not the dashboard.
So when a visitor lands on a 404 / access-denied / "no home page" page for a canvas, the button
points straight back at the same broken origin — frequently the *same page* that 404'd. The
button looks like a way out and is actually a no-op. This brainstorm frames the bug, the full
taxonomy of error cases that hit this page, the hard constraints (the §12.0 no-leak invariant,
no-JS self-contained pages, cross-origin), and the set of recovery actions the page should
offer.

## Problem Frame

**Root cause.** `renderErrorPage` does `const actionHref = escapeAttribute(details.actionHref ?? "/")`
(error-pages.ts:224) and `actionLabel ?? "Open dashboard"`. Almost every caller omits
`actionHref`, so the link is the relative `/`. Relative `/` resolves against the *current* origin:

- **Path mode** (one host): `/` is the dashboard root — the button works.
- **Subdomain mode** (the recommended multi-user prod): the error page is served on
  `{slug}.{baseHost}` (see `resolveRequest`, routing/resolve-request.ts:30-42 → `role: "canvas"`).
  `/` is that canvas subdomain's root. The dashboard actually lives at `config.baseUrl`
  (a *different* host). So "Open dashboard" never leaves the canvas origin.

This is worse for the most common canvas error states, because the canvas root is itself broken:

- `not_found` "missing" / `no-home` / `unpublished` (serve.ts:43-98, via `notFound()`): the
  button reloads a root that is itself a 404 → **literally the same page**.
- access-denied: by design returns an *identical* `404 not_found` (authorization.ts:304-313,
  no-leak §12.0) → same dead loop.

**The dashboard origin is known server-side.** `config.baseUrl` is the app/dashboard origin;
`canvasUrl()` already derives canvas hosts from it (canvas/url.ts:7-13). So a correct absolute
dashboard link is trivially constructible — the page just never does it.

**Identity is also knowable on a canvas subdomain.** The session cookie is scoped to
`.{baseHost}` in subdomain mode (auth/session.ts:41), so it *is* sent to canvas subdomains, and
the principal is resolved before `canvasAccess` denies (authorization.ts:292). So "you're signed
in as X" / a real logout link are *technically feasible* even on the canvas-subdomain error page
— subject to the leak constraint below.

**Secondary dead links of the same shape:**

- `loginUrl()` returns the **relative** `/auth/login` (auth/return-to.ts:96). On a canvas
  subdomain `/auth/*` is canvas-content (resolve-request.ts classifies non-base hosts as
  `canvas`), so any "sign in" affordance rendered there is also dead.
- The disabled-canvas page's hint "sign in to your dashboard to see why" (canvas/disabled-page.ts:33)
  has **no link at all** — just prose.

## Error-case taxonomy (does the right action depend on the error? — yes)

| Case | Where | Status/code | Origin it renders on | What the user actually needs |
|---|---|---|---|---|
| Canvas missing / no-home / unpublished | serve.ts `notFound()` | 404 `not_found` | canvas subdomain | Get to the dashboard (absolute). Maybe "this canvas isn't live yet". |
| **Access denied** (signed in, no access) | authorization.ts | 404 `not_found` (deliberately identical to missing) | canvas subdomain | Get to dashboard; *maybe* request access — **but must not differ from a real 404** (leak). |
| Not signed in, gated canvas | gateway / return-to | bounce to login (today) | — | Working **sign-in** link carrying `returnTo`. |
| Canvas disabled (admin takedown) | disabled-page.ts | 403 `disabled` | canvas subdomain | Dashboard link; owner hint. Static, no reason leak. |
| Dashboard SPA 404 / reserved-API 404 / stale asset | serve-spa.ts | 404 | app origin | Dashboard link works today (same origin) — but should still be absolute for consistency. |
| App-level 404 / 500 | app.ts onError/notFound | 404 / 500 | app origin | Dashboard link + retry. |
| OIDC sign-in didn't finish | oidc.ts | 400 | app origin | "Try signing in again" (already overridden). |

The throughline: **a working "back to the dashboard" link is universal**; everything else
(sign-in vs sign-out, "request access", owner hint) is case-specific — *and* gated by the leak
rule.

## Key Constraints (load-bearing)

- **No-leak invariant (§12.0).** Access-denied and genuine-not-found return a byte-identical
  404 on purpose. Any identity- or access-aware messaging ("you lack access to *this* canvas",
  "request access") rendered on the access-denied path but not the real-404 path would confirm
  the canvas exists. So such hints must be **generic and shown on both** ("If you expected
  content here and you're signed in, you may not have access — open your dashboard"), or not
  shown at all. We must not branch copy on the deny reason.
- **No-JS, self-contained, pre-gateway pages.** The error page ships zero script (only the
  inline pre-paint theme sync), no CDN, CSP with no `script-src`. "Logged in as" / logout that
  needs a fetch to an API breaks this model. Identity must be **server-injected into the static
  HTML**, not fetched client-side.
- **Cross-origin reality.** Dashboard, sign-in, and logout all live on `config.baseUrl`; the
  canvas error page is on a different origin. Every recovery link from a canvas subdomain must
  be an **absolute URL to the app origin**, not a relative path.
- **Org-agnostic, static-first.** No new client framework, no phone-home. Pure server-rendered
  additions to the existing page.
- **Auth-mode awareness.** "Sign in" / "sign out" only make sense in `oidc`/`dev` modes; in
  `proxy` mode the app never owns the login/logout (auth/factory.ts:24 — logout URL is undefined
  in proxy mode). Actions must adapt to `config.auth` mode, not assume an app-owned session.

## Requirements

**R1 — Working dashboard link (the core fix).** The primary recovery action resolves to the
**absolute** dashboard origin (`config.baseUrl`), not relative `/`, whenever the page may render
off the app origin (i.e. always in subdomain mode; harmless in path mode). "Open dashboard"
must leave a canvas subdomain.

**R2 — Threaded config.** `renderErrorPage` / `errorResponse` gain access to `config` (or a
pre-computed `appOrigin`) so the link, the auth mode, and identity can be injected. Today the
renderer has no config; this is the enabling change.

**R3 — Identity-aware footer (when safe & cheap).** When the principal is resolved at render
time and auth mode owns sessions (`oidc`/`dev`), the page may show a quiet "Signed in as
{email}" line with a **real, absolute logout** link to the app origin. When signed out (and the
case warrants it), show an absolute **sign-in** link carrying a `returnTo`. This is identity
state the user already knows — it does not leak canvas existence — but it must render
**identically regardless of the deny reason** (R6).

**R4 — Case-appropriate primary action.** Action(s) derive from the error case, not a single
hardcoded default:
- Canvas 404 / no-home / unpublished / access-denied → "Open dashboard" (absolute).
- Disabled → "Open dashboard" (absolute) + the existing owner hint, now with a working link.
- Sign-in-required surfaces → absolute "Sign in" carrying `returnTo`.
- App 500 → "Open dashboard" + optionally "Try again" (reload current).

**R5 — Fix the sibling dead links.** `loginUrl()` (and any sign-in affordance rendered on a
canvas subdomain) must produce an **absolute** app-origin URL there; the disabled page's "sign
in to your dashboard" hint must become a real link (R1's absolute dashboard URL).

**R6 — No leak via the new affordances (hard gate).** The access-denied 404 and the genuine 404
must remain byte-identical: same status, same copy, same actions, same identity footer logic. No
new branch may key on the access decision/reason. Any "you might lack access" hint is generic and
present on *both* (or neither). This is the §12.0 line — verify it with a test that diffs the two
responses.

**R7 — Auth-mode & no-JS fidelity.** No sign-in/out affordance in `proxy` mode (app doesn't own
the session). The page stays script-free and self-contained; identity is server-injected into
static HTML, never fetched. CSP unchanged (no `script-src`).

**R8 — Tests.** (a) subdomain-mode error page's primary link points at `config.baseUrl`, not the
canvas origin; (b) access-denied vs real-404 responses are identical (R6 regression); (c)
identity footer appears only in session-owning modes and only when a principal is present;
(d) path-mode behaviour unchanged.

## Open Questions for Mark

1. **Identity footer — in or out for v1?** Minimal fix = R1+R4+R5 (working absolute links, no
   identity). Fuller fix adds R3 ("Signed in as …" + logout/sign-in). The footer is the part
   that touches the leak invariant and needs the careful test. Recommendation: ship R1/R4/R5
   first (pure win, no invariant risk), then R3 as a fast follow.
2. **"Request access" affordance?** Tempting on the access-denied page, but it *cannot* exist
   only there (leak). Acceptable form: a generic "signed in and expected content here? you may
   not have access — open your dashboard" shown on every canvas 404. Want this, or keep the page
   minimal and neutral?
3. **Two buttons or one?** e.g. canvas 404 showing both "Open dashboard" and "View this canvas's
   public page" — though the latter is usually the thing that just failed. Leaning to a single
   primary action + a quiet identity/secondary line.
4. **Disabled page copy:** keep it static (no identity footer) to preserve the
   "anyone-with-URL" neutrality, or give it the same signed-in footer as the rest? It's already
   a distinct 403 page, so it can differ safely.
