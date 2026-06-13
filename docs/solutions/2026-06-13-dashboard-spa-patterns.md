---
title: Dashboard SPA (area E) — the patterns + traps building the management UI
type: architecture
area: dashboard
date: 2026-06-13
---

Reference for anyone touching the dashboard SPA (`apps/dashboard`), `serveSpa`, or
the session-authed management API it calls. Builds on
[[canvas-hosting-deploy-patterns]] and [[auth-invariant-checklist]].

## SPA internal routes must NOT use the `/c/` prefix (path mode collision)

In **path mode**, `resolveRequest` routes `/c/{slug}` to canvas *content* — so a
hard navigation to a dashboard route under `/c/...` (e.g. `/c/<id>/settings`) is
intercepted by canvas serving and returns canvas 404 JSON, never reaching the SPA.
The dashboard's own detail routes live at **`/canvases/:id`** (+ `/versions`,
`/settings`, `/usage`). `canvas.url` (the *real* canvas link) is the only place
`/c/{slug}` is correct. This was caught by screenshot verification (U10), not by
tests — a hard-load of a deep route is exactly what client-side router tests miss.
**Any new dashboard route must avoid `/c/`, `/v1/`, `/auth/`, `/api/`.**

## serveSpa: serve the built SPA from Hono safely

`apps/server/src/dashboard/serve-spa.ts`, mounted at the **post-gateway** catch-all
(role `dashboard`), so login-on-every-request holds for the shell itself — never
mount it before `authGateway` the way `/auth` and `/v1/canvases` are.

- **Resolve `dist/` from the module, not cwd** — `import.meta.url` +
  `../../../dashboard/dist`, with `CANVAS_DROP_DASHBOARD_DIST` (config, not raw
  `process.env`) override. A cwd walk-up works in the monorepo/tests but silently
  404s in a packaged `node apps/server/dist/index.js` run (the
  [[ci-and-test-infra-gotchas]] cwd-relative trap).
- **A missing hashed `/assets/*` must 404, NOT fall back to `index.html`.** With
  lazy-loaded route chunks, a stale chunk requested across a redeploy would
  otherwise get `index.html` (200/text/html); `nosniff` then blocks executing HTML
  as a module and the route blanks out. A 404 lets the app reload cleanly. Reserve
  the history fallback for non-asset, extension-less paths.
- **`decodeURIComponent` throws on malformed `%` encoding** — wrap it; a bad URL
  should serve the shell, not 500.
- The path-traversal guard is `candidate === distDir || candidate.startsWith(distDir
  + sep)` *after* `normalize()`+`join()`. Verified safe against encoded `..`, null
  bytes, and directory requests. Strict CSP (`default/script/style/connect 'self'`,
  `font-src 'self'`, `frame-ancestors 'none'`) is on the dashboard *document* — it
  does **not** govern canvas documents; the path-mode canvas→management residual is
  `Sec-Fetch-Site` + `SameSite` cookies (§12.2), not CSP. Don't over-claim it.

## New session-authed endpoints reuse the foundation primitives

`/api/canvases/:id/versions` and `/rollback` reuse `ownedCanvas` (404 for
non-owner, no existence leak) + `requireSameOrigin` on the mutation; rollback's
`findReadyByNumber(cv.id, n)` is canvas-scoped so a cross-canvas version number
can't resolve (§12.0 #4). `/api/me` is its **own** router (not under
`/api/canvases`, whose `/:id` would match `me`) and returns an **explicit 5-field
projection**, never a spread of the user row. `requireSameOrigin` passes
header-absent / non-browser calls by design — it blocks browser cross-site, not
scripted calls; `ownedCanvas` is the real authz gate. Don't describe same-origin as
a total cross-origin block.

## SPA data layer (`apps/dashboard/src/lib`)

- **Auth-expiry is a first-class client branch (KTD-8).** A long-lived SPA hits
  expired sessions; the gateway answers 401 (dev/proxy) or 302→login (oidc), and a
  proxy may serve its login page as **200 text/html**. `api.ts` treats
  `status===401 || res.redirected || (res.ok && !isJson)` as expiry → full-page
  navigation to login (idempotent). A **non-2xx** HTML body (e.g. 5xx) is NOT
  expiry — it surfaces as a normal `ApiError`. Getting this wrong either misses
  re-auth or redirects to login on a server error.
- **Optimism only where reversible** — settings toggles optimistic w/ rollback;
  rollback/regen/delete/deploy confirm-and-await. Trap: seed local form-field
  mirrors on **`canvas.id`**, not the `canvas` object — an optimistic toggle
  rewrites the cached object identity and a `[canvas]`-keyed effect would clobber
  unsaved text edits.
- **Key-once + orphan cleanup.** The folder/ZIP create flow is two calls
  (`createCanvas` then `deploy*`); on deploy failure, `deleteCanvas` the orphan
  (mirror the server `/paste` cleanup) so no empty canvas + forfeited key is left.
- Keys live only in ephemeral React state — never localStorage/cache/URL/logs.

## Token-first design (re-skin contract)

Every color/space/radius is a CSS var (`@theme inline` over runtime vars), so a
theme switch is live and a deployment re-skins by editing tokens. Watch for
hard-coded bypasses: a `bg-white` thumb or a `warning` tone reusing
`success-subtle` breaks the contract and dark mode. Geist is self-hosted
(`@fontsource-variable/*`, bundled by Vite) — no font CDN, satisfying `font-src
'self'` + the no-phone-home rule.

## Test infra

- **HTTP route tests stay sqlite-only.** They verify auth/routing/response shaping
  — dialect-independent. The dialect-sensitive new code (`versions.findByIds`'
  empty-array `in ()` case) is dual-dialect tested at the **repo** level
  (`versions.test.ts`). Running the whole route suite on pglite ~doubles its time
  for no extra SQL coverage. (CI splits dialects into parallel jobs anyway, so the
  serial both-dialect cost is only a local `pnpm test` concern.)
- **Dashboard tests** run in a workspace-scoped jsdom `vitest.config.ts`; the root
  config (node + `CANVAS_DROP_DB` dialect split) is left untouched. CI runs the
  dashboard jsdom suite once in its own job.

## Rollback-vs-prune race — fixed (two atomic guards)

A rollback to an old version concurrent with a deploy's prune could leave
`canvases.current_version_id` dangling (no FK; serve.ts then 404s the live canvas
until the next deploy). Closed on **both** rollback paths with two
single-statement guards — no cross-dialect transaction (the codebase avoids
those, see [[canvas-hosting-deploy-patterns]] "Atomic-ish commit"):

1. `versionsRepository.pruneBeyond` re-reads the live pointer **inside** its
   DELETE (a correlated `notInArray` subquery over an `isNotNull`-filtered
   `current_version_id`) and returns the rows actually deleted — a version a
   concurrent rollback just made current is never pruned, even against a stale
   drop-set snapshot.
2. `canvasesRepository.setCurrentVersionIfReady` swaps the pointer only if the
   target is still ready (`UPDATE ... WHERE id=? AND EXISTS(ready version)`),
   returning whether it succeeded; both rollback handlers return a clean
   `VERSION_UNAVAILABLE` (409) when the target was pruned mid-race.

Either interleaving is safe: prune-first → rollback fails cleanly; rollback-first
→ prune skips the now-current version. The deploy path keeps the unconditional
`setCurrentVersion` (its just-created version is always ready, never racing prune).
