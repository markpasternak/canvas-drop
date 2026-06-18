---
title: CDN-readiness — access-aware cache headers, weak-ETag 304s, real client IP, edge-staleness warning
type: architecture
area: serving
date: 2026-06-18
---

## What this is

Making canvas-drop correct behind a shared cache (CDN/reverse-proxy). A load test
(~300 rps origin ceiling, single VPS) raised the question of fronting prod with a CDN;
reading the serve path surfaced one real bug and several behaviors that change behind a
shared cache. The operator-facing writeup is the served doc [docs/site/self-hosting/cdn.md](../site/self-hosting/cdn.md);
this captures the decisions and the non-obvious bits.

## The bug it fixed

`canvas/serve.ts` emitted `Cache-Control: public, max-age=1y, immutable` on **every**
content-hashed asset, regardless of the canvas's access rung. Since serving runs *after*
the access gate, the origin only hands bytes to authorized viewers — but `public` tells
a **shared** cache it may store and replay them to anyone. So a private/guest canvas's
hashed JS/CSS were advertised as shared-cacheable. The HTML stayed `no-cache` (entry
point always re-checked), which bounded the blast radius, but it was still wrong. The
codebase already knew the pattern — `http/landing-page.ts` uses `private` + `Vary:
Cookie` for exactly this reason — it just wasn't applied to canvas assets.

## Decisions

- **Only the `public_link`, no-password rung is `public`.** It's the single rung an
  anonymous request can reach (`canvas/authorization.ts`), so it's the only one a shared
  cache may hold. Every other rung → `private`. One predicate, computed in serve.ts:
  `canvas.access === "public_link" && canvas.passwordHash === null`.
- **Public HTML is shared-cacheable but the browser still revalidates.**
  `public, max-age=0, s-maxage=<TTL>` — `s-maxage` is the CDN window; `max-age=0` keeps
  the viewer's own browser revalidating each load, so *the viewer* sees access changes
  instantly even while the edge serves a cached copy to anonymous traffic.
- **One config knob drives both the header and the warning.**
  `CANVAS_DROP_PUBLIC_EDGE_CACHE_TTL` (default 300s, 0=off) is the `s-maxage` AND the
  number quoted in the owner-facing downgrade warning, so they can never disagree. The
  shared logic lives in `http/cdn-cache.ts` (`canvasCacheControl`, `humanizeDuration`,
  `cdnAccessDowngradeWarning`).
- **Generic, not vendor-specific (org-agnostic rule).** No hardcoded `CF-Connecting-IP`.
  `CANVAS_DROP_CLIENT_IP_HEADER` names whatever header your CDN sends; the app reads it
  only when the peer is a trusted proxy (same §12.5 gate as XFF).
- **The warning is advisory, conditional, and parity-complete.** The server can't know
  whether a CDN is actually deployed, so the copy is "*if* you serve through a CDN…".
  It's returned from the shared `resolveSettingsUpdate` resolver, so both the dashboard
  Share tab (toast) and the MCP `update_canvas` tool surface it — agent-native parity.

## Non-obvious bits / gotchas

- **Weak-ETag 304s.** A CDN that compresses a response downgrades a strong `ETag` to
  weak (`W/"…"`) and echoes the weak form back in `If-None-Match`. The old strict `===`
  compare would miss it and force a full `200` — the *opposite* of what a CDN is for.
  Fixed with a value-compare that strips the `W/` marker and handles a comma-list
  (`ifNoneMatchHits` in serve.ts). For a content-hash ETag the strong/weak distinction
  is meaningless anyway — a value match is a content match.
- **A CDN gives ~zero offload by default.** Origin HTML is `no-cache` (auth-gated) or
  `s-maxage` (public), and CDNs don't cache HTML without an explicit cache rule. So the
  ~300 rps origin ceiling is *not* relieved just by switching the proxy on — you need a
  cache rule, and it must bypass on the session cookie or it can serve gated content.
  That cookie-bypass is belt-and-suspenders on top of the `private` headers.
- **`CANVAS_DROP_PUBLIC_EDGE_CACHE_TTL` needs `nonNegInt`, not `posInt`.** The existing
  `posInt` env helper rejects 0; "0 = disable shared caching" needs `>= 0`. Added a
  `nonNegInt` helper in `config/env.ts`.
- **Client IP behind a CDN is rate-limit/audit correctness, not auth.** Prod runs
  `oidc`; the peer-IP trust gate only matters in `proxy` auth mode. Left unconfigured, a
  CDN makes every request share the CDN's IP bucket (collateral login throttling, CDN
  IPs in audit rows) — but it can never bypass auth. See
  [[2026-06-13-auth-invariant-checklist]] for the §12.5 peer-vs-client distinction.

## Surfaces touched

`config/env.ts` (2 vars + `nonNegInt`), `http/cdn-cache.ts` (new), `canvas/serve.ts`,
`http/client-ip.ts` + `app.ts`, `canvas/settings-update.ts` (+warning) and its callers
`routes/management.ts` + `mcp/server.ts`, `admin/config-fields.ts`, the dashboard Share
tab, `.env.example` + `.env.production.example`, and the ops guide. Tests: `cdn-cache`,
`client-ip`, `serve`, `settings-update`.
