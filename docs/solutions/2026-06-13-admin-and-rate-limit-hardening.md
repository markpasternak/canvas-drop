---
title: Admin panel + broad rate limiting + §12.5 hardening (M7) — the seams and the traps
type: architecture
area: admin
date: 2026-06-13
---

## What this is

The M7 build (plan 010): the admin panel (areas K) and the hardening pass (area L)
— takedown/restore, model allowlist + quota defaults, broad route-class rate
limiting, the §12.4 header baseline, audit completeness, and §12.5 trusted-proxy
test hardening. Read this before touching the admin surface, the rate limiter, or
the takedown lifecycle. See also [[auth-invariant-checklist]] (the §12.0
invariants this upholds) and [[canvas-primitives-runtime-api]] (the route classes
it throttles).

## Admin authz: server-resolved, 404-not-403, cross-owner reads are the ONLY exception

- `isAdmin` is resolved server-side from `CANVAS_DROP_ADMIN_EMAILS` at user upsert
  (`identity-mapping.ts`) and lives on the `users` row — **never client-asserted**
  (§12.0 #1). `requireAdmin` (`admin/authz.ts`) returns **404** (not 403) to a
  non-admin, matching `ownedCanvas`'s existence-non-confirmation posture.
- `adminRepository` (`db/repositories/admin.ts`) is the **only** repository that
  reads canvases across every owner. Every other read path is owner-scoped. Keep
  it that way — a cross-owner read anywhere else is a §12.0 #3 leak.
- The dashboard "Admin" nav link is gated on `me.isAdmin`, but that is **UI only**
  — the API independently 404s non-admins. Don't describe the hidden link as a
  security boundary.

## Takedown lifecycle: the disabled state is authoritative and can't be laundered

- `disabled` was already a status + a `decideCanvasAccess` 403 branch (plan 002).
  M7 added the admin transition into it (`setDisabled`/`enable`), a stored
  **`disabled_reason`** (one column — who/when lives in `audit_log`, not duplicated
  on the row), and the rendered page.
- **The disabled branch fires before owner/admin** in `decideCanvasAccess`, so an
  admin's slug load / runtime API also gets the disabled page / `{code:"DISABLED"}`
  — admins are NOT exempted (§12.0 #5). The owner learns *why* from the dashboard
  (the owner/admin-gated `disabledReason` projection), never from the public page.
- **Two laundering paths a review caught, both closed:**
  1. Owner `archive`→`unarchive` of a disabled canvas would flip it back to active.
     Fixed by re-guarding `archive` to `WHERE status='active'` only.
  2. Owner `delete`→admin-`restore` would relaunch a taken-down canvas as `active`
     (an admin restoring from the deleted view doesn't know it was a takedown).
     Fixed by **blocking deletion of a disabled canvas** (409). *(Updated 2026-06-16,
     D-admin-restrict: the admin delete-of-disabled shortcut was removed — it now 409s
     for everyone; the canvas must be re-enabled via the admin route, then the owner
     deletes it. See [[2026-06-16-admin-content-restriction-and-deploy-draft-sync]].)*
     `restore` clears `disabled_reason` so no stale note rides onto
     a live row. *Lesson:* when you add an admin-authoritative state, walk EVERY
     owner-initiated transition out of it — the guard on the obvious one (archive)
     isn't enough.
- **`publicCanvas` is misnamed** — it's the owner/admin projection (all callers are
  `ownedCanvas`/`requireAdmin`-gated) and carries `disabledReason`. Any future
  public/shared/gallery view must be a SEPARATE function that omits it.

## Broad rate limiting: one path-first classifier, server-derived keys, in-process

- `rate-limit.ts` is **one** middleware driven by a pure `classifyRequest` — NOT a
  per-route list — so it auto-covers the M6 primitives and any future AI/realtime
  HTTP route. It is **path-first**: `resolveRequest` classifies `/api/*`, `/admin/*`,
  and the SPA all as `role:"dashboard"`, so you CANNOT classify on role; key off the
  pathname (`/v1/c/<slug>/ai/*` → ai, other `/v1/c/<slug>/*` → canvas,
  `startsWith("/api/")` → management, else skip).
- **Keys are server-derived only** (`user.id` from the gateway, the path slug, the
  socket-peer IP, the canvasId after Bearer-verify) — never a client header
  (§12.0 #1). Key the canvas bucket on the **path slug** (`runtimeMatch[1]`), not
  the host-derived `canvasSlug` — in subdomain mode the latter is the host
  subdomain and would mis-attribute the bucket.
- **In-process fixed-window store** (§9.7 single process; no `RateLimitStore`
  interface — its only second impl, Redis, is out of scope every milestone). The
  key-cap eviction must **never evict a LIVE bucket** (that wipes another user's
  counter) — only reclaim expired buckets, else fail OPEN for that one request.
- **Three out-of-band mount points** share the one store (so MAX_KEYS bounds
  everything): the pre-gateway Bearer deploy (keyed by canvasId after key-verify;
  no-key → 401 before the throttle, never 429), login (pre-gateway, per-IP), and
  the password-gate POST (per-user+canvas). The broad middleware is post-gateway.
- **Limit values are config/env** (`config.rateLimit`, §12.3 defaults) — use
  **`posInt`** not `num` so a `0`/negative typo fails loud at boot instead of
  silently 429-ing every request in a class. Live admin-tunable *rate limits* are a
  follow-up; the admin panel tunes *quota* defaults (KV keys, file bytes, AI $),
  which are a separate concern read through `effectiveQuota` (a plain per-request
  settings read — **no cache**; premature at D13 scale).

## Security headers: a helper, because self-Response handlers bypass middleware

- `baseSecurityHeaders(headers)` (`http/security-headers.ts`) is the single source
  of truth (nosniff, Referrer-Policy, **COOP**). Handlers that build their own
  `Response`/`c.body(...)` with an explicit `Headers` (canvas serve, file serving,
  SPA, draft preview, disabled page) call it directly — an outer `c.header()` after
  `next()` does NOT merge into a finalized Response. A fallback middleware applies
  the baseline to `c.json` API responses (which previously had none). COOP was
  already on the SPA; the gaps were canvas content + the JSON API.

## Audit vs metering: distinct sinks

KV/file **mutations** (set/delete/increment, upload/delete) write an `audit_log`
row (`kv_mutation`/`file_*`) — the §12.1.8 security trail, **distinct** from the
fire-and-forget `usage_events` metering (which is for stats). Reads are NOT audited
(volume; mutations are what an incident review needs). Both are fire-and-forget and
never fail the request path.

## Pagination: keyset on the UUIDv7 id, not created_at

The admin all-canvases list keysets on the **`id`** (unique + time-ordered — its
first 48 bits are the creation ms), NOT `created_at`. A `created_at`-only cursor
silently DROPS rows that share the boundary millisecond (two creates in the same ms
— easy in a loop/burst). The id keyset is exact. The bug-prone test passed
vacuously (empty page2 on a tie) — assert the **union across all pages equals every
row**, not just "no overlap".

## §12.5: log the stray identity header in the JWT-FAILURE path too

The JWKS trust path already never falls through to header trust. M7 added logging
of a stray identity header in BOTH the JWT-absent AND JWT-verification-failure
paths — the failure path (forged token + forged header) is the downgrade-probe case
the original code logged nowhere. Test the rejection paths first; assert the log
fires.
