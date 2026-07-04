---
title: Host-scope platform/marketing routes so they don't shadow tenant canvases (isolate a sub-app + delegate, don't merge)
type: bug
area: routing
date: 2026-07-04
---

**The bug.** In `apps/server/src/app.ts` the platform/marketing routers were mounted
at `"/"` globally with no host scoping and BEFORE the tenant canvas chain:
`brandAssetRoutes` (`/favicon.svg`, `/site.webmanifest`, `/brand/*`, `/fonts/*`),
`legalRoutes` (`/privacy`, `/terms`), the `/welcome` alias, and `docsRoutes`
(`/docs`, `/docs/*`, `/og.png`, `/llms.txt`, `/skill.zip`). Hono matches merged routes
in **registration order**, so on a canvas subdomain (`{slug}.{baseHost}`) every one of
those reserved paths won over the later per-canvas asset chain
(`resolveAsset` + `serveCanvas` + SPA fallback). Result: a canvas that shipped its own
`/docs` (or `/og.png`, `/llms.txt`, …) was silently served canvas-drop's OWN platform
page instead. Toggling the canvas's SPA-mode did nothing — the SPA fallback lives in the
tenant layer that was never reached. (`landingGate` already special-cased "a canvas
subdomain's `/` is the canvas" for the root, but the reserved sub-paths had no such guard.)

**The Hono wrinkle (the load-bearing lesson).** `app.route("/", sub)` *merges* the
sub-app's routes into the parent, and a merged route wins by registration order on
**every host**. There is no per-request way to make a merged route fall THROUGH to a
later `*`-mounted chain — a guard middleware placed next to it can only `next()` INTO the
matched handler, not skip past it to the canvas chain. So the only way to host-scope a
family of already-merged routes is to stop merging them:

1. Build the whole family into its **own** `Hono` sub-app (`const platform = new Hono()`;
   `platform.route(...)` for brand/legal/docs, `platform.get("/welcome", ...)`).
2. **Delegate** to it from a single `app.use("*")` guard behind the existing apex-vs-canvas
   seam — `resolveRequest({host, pathname}, config).role === "canvas"` (the SAME seam
   `landingGate` uses). Canvas host → `return next()` (fall through to the tenant chain);
   apex host → `const res = await platform.fetch(c.req.raw)`.
3. Distinguish "no platform route matched" (→ continue the parent chain unchanged) from a
   real platform response with a **`notFound` sentinel**: `platform.notFound()` returns a
   404 carrying an internal header (`x-canvas-drop-platform-miss`); the guard swaps that
   sentinel for `next()`, so a client never sees it. Without the sentinel you can't tell
   an unmatched apex path (`/`, `/api/*` → must fall through) from a matched platform page.

**Gotchas that made this safe:**
- The platform routers must be **closure-only** (they read `config`/`skin` via closure and
  `c.req`, never `c.get(...)` context values) — `platform.fetch(c.req.raw)` runs a FRESH
  context, so anything stashed by parent `*` middleware (`c.set("config")`, `peerIp`,
  `clientIp`) is absent. Verify before delegating. (These four routers happened to qualify.)
- Gate the delegation to **GET/HEAD** (every platform page is GET) so you never re-enter a
  sub-app fetch with a POST body that a later handler needs.
- Keep the guard **pre-auth-gateway** on the apex — signed-out agents/crawlers (and Google's
  OAuth consent reviewers) must still reach `/docs`, `/llms.txt`, `/privacy`. The delegation
  sits where the old mounts sat, before the login throttle + gateway.
- **`path` mode is a no-op**: every host is the apex and canvases live under `/c/{slug}`, so
  the apex root paths never collide — don't regress that (a regression test pins it).
- Accepted edge case: a *matched-but-missing committed asset* on the apex (e.g. `/og.png`
  absent) calls `c.notFound()` → the sentinel → falls through instead of 404-ing. Harmless
  (assets are committed) and only in a broken deploy.

**Test trap.** An existing test (`app.test.ts`, "R10") *asserted the bug* — docs reachable
on `abc.canvases.example.com`. "Reachable on any host" was the wrong contract; it had to
become "reachable on the apex host." When you fix a shadowing bug, grep for the test that
encoded the old behavior and flip it, then add a positive regression: deploy a `public_link`
canvas whose static files collide with every reserved path and assert its OWN content serves
on the subdomain while the apex still serves the platform pages.

Same family of insight as [[2026-06-23-error-page-absolute-recovery-links]] and
[[2026-06-16-oidc-subdomain-cookie-and-returnto]]: **subdomain mode means a canvas host is a
different tenant origin — anything mounted at `"/"` must ask "apex or canvas?" first.**
