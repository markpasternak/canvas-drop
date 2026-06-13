---
title: "feat: Admin panel + hardening (M7, areas K + L)"
type: feat
status: completed
date: 2026-06-13
milestone: M7
areas: [K, L]
origin: BUILD_BRIEF.md §16 M7, §6.10, §6.11, §12
---

# feat: Admin panel + hardening (M7, areas K + L)

## Summary

M7 hardens the platform now that the real primitive surface exists (M6). Two halves:

- **Area K — Admin panel (§6.10).** An admin-only dashboard surface: an all-canvases
  list (owner / status / size / usage / last-activity) across every owner; **takedown**
  (disable a canvas so its public URL shows a "disabled" page and the owner sees why);
  **restore** a soft-deleted canvas; **AI model-allowlist** management; **global quota
  defaults**; and a **platform usage overview** (totals, top canvases). `isAdmin` is
  resolved server-side from `CANVAS_DROP_ADMIN_EMAILS` (already in `Config` + on the
  `users` row) and is **never** client-asserted.
- **Area L — Hardening (§6.11/§12).** Broad **route-class rate limiting** on every
  `/v1/c/:slug/*` runtime call and every `/api/*` management call — keyed by user (and
  canvas for runtime), implemented as one classifier-driven middleware so it automatically
  covers the M6 primitives and any AI/realtime HTTP routes that land later. Plus a
  **security-headers** baseline review (§12.4), **audit-log completeness** for the new
  admin + primitive surfaces (§12.1.8), and **trusted-proxy/IAP §12.5** verification
  hardening (strip inbound identity headers at our trust edge; test the rejection paths).

**Trust model (calibration, not a loophole).** canvas-drop runs inside a trusted org
(everyone has passed org SSO; the email-domain allowlist keeps outsiders out — §12.0).
The §12.0 **hard invariants** (no impersonation, no cross-user/cross-canvas theft, no
unauthorized access, lifecycle honored instantly) are absolute and weighted P0. Beyond
them, stay proportionate: light defense-in-depth for accidents and resource safety, not
elaborate anti-malicious-insider machinery. Admin authz, takedown lifecycle, and §12.5
trusted-proxy paths are §12.0-invariant surfaces — they get the P0 weighting; the
rate-limit store and quota plumbing are resource-safety, right-sized.

**Out of scope (deferred):** deployment / backup / load-test / OSS packaging (M10); the
AI / realtime / gallery *features* themselves (M8/M9). The model allowlist and AI quota
defaults are *managed* here (so the admin surface is whole) and *consumed* when AI ships.

---

## Problem Frame

Today every canvas is owner-scoped: there is no cross-owner visibility, no operator lever
to take down an abusive or broken canvas, no way to bring back a soft-deleted one, and no
place to set platform-wide policy (model allowlist, quota defaults). And although the
primitive surface (KV / files / `me()`) is live and metered, **nothing throttles it** —
`usage_events` records ops but rate limiting was explicitly deferred from M6 to M7. A
single colleague's runaway script (or a pathological loop in a canvas) can hammer the KV
or management API unbounded. The §12.4 headers, §12.1.8 audit coverage, and §12.5
trusted-proxy hardening also need a consolidated review now that the surfaces they protect
all exist.

M7 closes these: an admin can see and govern the whole platform, every API class is
throttled by a single broad middleware, and the security review of the five invariants
(§12.0, §6.11.11) has the real surfaces to evaluate.

---

## Requirements

Traced to BUILD_BRIEF §6.10 (admin), §6.11 (security/ops), §12 (security requirements).

| ID | Requirement | Source |
|----|-------------|--------|
| R1 | Admin-only dashboard surface; `isAdmin` resolved server-side, never client-asserted; non-admins get 404/403 on admin routes (no existence leak) | §6.10, §12.0 #1 |
| R2 | All-canvases list across every owner: owner, status, size, usage, last-activity | §6.10.1 |
| R3 | Disable/takedown: public URL shows a "disabled" page; owner sees *why* | §6.10.2 |
| R4 | Restore a soft-deleted canvas | §6.10.5 |
| R5 | AI model-allowlist management (managed now, consumed by AI in M9) | §6.10.3 |
| R6 | Global quota defaults (managed now; wired into the primitives that exist) | §6.10.4 |
| R7 | Platform usage overview: totals, top canvases (AI spend deferred to M9) | §6.10.6 |
| R8 | Per-user **and** per-canvas rate limiting on all API classes (§12.3 values), implemented as broad route-class middleware, not a per-route list | §6.11.2, §12.3 |
| R9 | Security headers everywhere (§12.4): nosniff, Referrer-Policy, COOP, frame-ancestors | §6.11.3, §12.4 |
| R10 | Audit-log completeness: admin actions + canvas API mutations (the new surfaces) | §6.11.1, §12.1.8 |
| R11 | Trusted-proxy/IAP §12.5 hardening: strip inbound identity headers at our trust edge; log untrusted-header presence; rejection paths tested | §12.5 |
| R12 | Lifecycle honored instantly: a disabled canvas is denied on the very next request (no cached grant), consistent with archive/delete/revoke | §12.0 #5 |

**Success criteria:** an admin can list/takedown/restore/govern from the dashboard;
non-admins cannot reach any of it; every runtime + management API class returns `429` past
its limit; the full dual-dialect suite is green including admin-authz, takedown-lifecycle,
§12.5-rejection, and rate-limit (runtime + management) tests.

---

## High-Level Technical Design

### Request pipeline with the new rate-limit seam (app.ts middleware order)

The rate limiter is **one** middleware mounted after the auth gateway + role-resolution
(so `user` and `canvasSlug` are known and server-derived) and before the route handlers.
A pure classifier maps each request to a `(class, key, limit)` triple; static canvas
content and the SPA shell are not throttled (they are not API classes).

```
request
  │
  requestLogger ─ clientIp(conninfo) ─ /healthz ─ /auth ─ [/v1/canvases Bearer deploy]*
  │
  authGateway ............ resolves server-side identity (login on every request, §12.0 #1)
  │
  role middleware ........ sets role + canvasSlug (resolveRequest)
  │
  ┌──────────────────────────────────────────────────────────────┐
  │ rateLimit(store, config)   ← NEW (U7)                         │
  │   classifyRequest(c) → null | { class, key, limit, windowMs } │
  │   **PATH-FIRST** (role does NOT distinguish /api/* from SPA —  │
  │    resolveRequest classifies both as role "dashboard"):       │
  │     path /v1/c/<slug>/ai/* → "ai"   60s, key ai:user          │  (auto-applies when AI lands)
  │     path /v1/c/<slug>/*    → "canvas" 60s, key canvas:user:slug│
  │     path startsWith /api/  → "management" 60s, key mgmt:user   │  (incl. session publish/rollback/deploy)
  │     else (content/spa/sdk/healthz/auth) → null (skip)          │
  │   role/canvasSlug used ONLY to derive the key, never to class. │
  │   store.hit(key, limit, windowMs) → { allowed, retryAfterSec } │
  │   not allowed → 429 + Retry-After (envelope per surface)       │
  └──────────────────────────────────────────────────────────────┘
  │
  /v1/c/:slug/* runtime ─ /sdk/v1.js ─ /api/me ─ /api/canvases ─ /api/admin/* (NEW U4)
  │
  onlyCanvas( canvasAccess → passwordGate → serveCanvas )   ← disabled page rendered here (U5)
  │
  dashboard SPA (serveSpa)  ─  404 fallback
```
**Two additional rate-limit mount points outside the broad middleware (not gaps):**
- **Bearer deploy API** (`/v1/canvases/*`) mounts *before* the gateway (no org session). Its
  `deploy` throttle (10/min/canvas, §12.3) is applied **inside** `deployApiRoutes`, keyed by
  `canvasId` resolved *after* the Bearer key is verified (no `user` in context on this path).
  Session-side publish/rollback ride the `management` class (same-origin + session-gated;
  60/min is right-sized) — the strict 10/min deploy limit guards the programmatic/agent path,
  which is where runaway deploys actually originate.
- **Login** (`/auth/*`, pre-gateway, 5/min/IP keyed by conninfo socket peer) and
  **password-gate** (the gate POST, 5/min/user, §12.3) are applied at those handlers — they
  defend the credential surface (§12.0 #1/#3) and run before/outside the org-session classes.

### Takedown lifecycle (status state machine — the `disabled` transition is new wiring)

`disabled` already exists as a status value and in `decideCanvasAccess` (403, reason
`disabled`); M7 adds the **admin transition into/out of it**, a stored **reason**, and the
**rendered page**.

```
            ┌─────────┐  admin disable(reason)   ┌──────────┐
            │ active  │ ───────────────────────► │ disabled │
            │         │ ◄─────────────────────── │          │
            └─────────┘     admin enable          └──────────┘
              │  ▲          (clears disabled_reason)   │
   owner      │  │ owner unarchive          public:    │ 403 → HTML "disabled" page (admin too)
   archive    ▼  │                          owner:     │ dashboard shows disabled_reason
   (active     ┌──────────┐                            ▼
    only!)     │ archived │          (content path renders page; runtime API → 403 DISABLED;
            └──────────┘            admin is NOT exempted — disabled fires before owner/admin)
                 │ owner delete
                 ▼
            ┌─────────┐  admin restore   ┌─────────┐
            │ deleted │ ───────────────► │ active  │   (clears deleted_at; within retention)
            └─────────┘                  └─────────┘
```

`decideCanvasAccess` order is unchanged (deleted→404, archived→404, disabled→403, owner/
admin→allow, …): the disabled branch is hit **before** owner/admin so even the owner's —
and the **admin's** — public URL / runtime API shows the disabled page (§12.0 #5 honored for
everyone). They learn *why* from the dashboard, not the slug.

**Lifecycle guard (adversarial review):** the owner-initiated `archive` transition must be
re-guarded to fire **only from `active`** (currently `ne(status,'deleted')`, which would let
an owner archive→unarchive a *disabled* canvas and silently reverse an admin takedown). See
U2 — archive of a non-active canvas returns false → 409 `NOT_ACTIVE`.

### Effective-quota resolution (admin defaults override config/constant fallback)

```
effectiveQuota(key) =
   settings["quota.<key>"]  (admin-set, plain per-request read)
   ?? config default        (env, e.g. ai.userDailyUsd)
   ?? hard constant         (e.g. KV_MAX_KEYS_SHARED)
```
A plain per-request `settings` read (a primary-key lookup on a tiny table) — **no
in-process cache** (scope review: a cache is premature at D13 / 50–150-user scale, and its
stale-window + invalidation logic is complexity the trusted-org load doesn't demand; add it
later only if instrumentation shows the read matters). Rate-limit *values* stay
config/env-driven (hot path, allocation-free); quota *defaults* (KV keys, file bytes, AI $)
are the admin-tunable knobs per §6.10.4.

---

## Output Structure

New files (server + dashboard). Existing files modified are listed per unit.

```
apps/server/src/
  http/
    rate-limit.ts            # in-process fixed-window store fn + path-first classifier + middleware (U7)
    rate-limit.test.ts
    security-headers.ts      # shared baseline-headers helper (U8)
    security-headers.test.ts
  admin/
    authz.ts                 # requireAdmin middleware (U2)
    authz.test.ts
    settings-service.ts      # model allowlist + quota defaults, settings-backed + cached (U3)
    settings-service.test.ts
  routes/
    admin.ts                 # /api/admin/* routes (U4)
    admin.test.ts
  db/repositories/
    admin.ts                 # cross-owner list + platform stats + restore/disable repo methods (U2)
    admin.test.ts
apps/dashboard/src/
  routes/
    admin.tsx                # admin all-canvases + actions (U6)
    admin.settings.tsx       # model allowlist + quota defaults + usage overview (U6)
  components/
    AdminCanvasTable.tsx     # (U6)
```

---

## Key Technical Decisions

**KTD-1 — Rate-limit store is a plain in-process store function (per §9.7); no swappable-driver
ceremony.** BUILD_BRIEF is explicit: single process, in-memory fan-out, no broker at D13
scale (§9.7). `inProcessRateLimitStore()` returns an object with one method,
`hit(key, limit, windowMs) → { allowed, remaining, resetAt, retryAfterSec }`, over a
fixed-window counter `Map<key, {count, resetAt}>` with lazy expiry + a periodic sweep and a
defensive key-count cap. We export the **function**, not a `RateLimitStore` interface — a
named single-implementation abstraction whose only hypothetical second impl (Redis) is
out of scope for every planned milestone is premature (scope review). A small store-shape
*type* for test injection (fake clock) is fine; the swappable-Redis-driver framing is not.
*Rationale:* matches the brief's architecture; extracting an interface later when a second
impl actually exists is trivial; maintaining a dead one through M8–M10 is not.

**KTD-2 — One **path-first** classifier, not a per-route list (R8 is explicit about this).**
The middleware calls a single pure `classifyRequest(c)` that returns the route class **from
the request path** — *not* from `role`. This matters: `resolveRequest` classifies `/api/*`,
`/admin/*`, and the SPA shell all as `role: "dashboard"` (feasibility review), so `role`
cannot distinguish a management call from an SPA document fetch. The classifier matches
`/v1/c/<slug>/ai/*` → `ai`, other `/v1/c/<slug>/*` → `canvas`, `path.startsWith("/api/")` →
`management`, else `null` (skip). `role`/`canvasSlug` are used only to *derive the key* once a
path class is chosen. Adding a primitive (AI, realtime HTTP) needs **zero** changes — its
path already classifies. *Rationale:* the instruction mandates broad coverage that
auto-covers future routes; a hard-coded list would silently miss them, and a role-keyed
classifier would mis-throttle the SPA and `/api/me`.

**KTD-3 — Rate-limit *values* from `Config` (env), quota *defaults* from `settings` (admin),
plain read.** §12.3 limits (60/min canvas API, 10/min AI, 10/min deploy, 5/min login,
5/min password-gate) are enforcement constants on the hot path — config/env with §12.3
defaults, no per-request DB read. §6.10.4 "global quota defaults" (KV key counts, file bytes,
AI $/day) are policy knobs the admin edits — stored in the `settings` table, read through a
plain `effectiveQuota` resolver (settings ?? config ?? constant), **no cache** (premature at
D13 — scope review). *Rationale:* keeps the hot rate-limit path allocation-free while making
the admin "quota defaults" feature real for the primitives that exist, without a stale-window
caching layer the scale doesn't need. Live admin-tunable *rate limits* are a clean follow-up
(would need a settings read on the hot rate-limit path) — noted, not built.

**KTD-4 — Keyed by server-derived identity only (invariant #1).** The rate-limit key uses
`c.get("user").id` (and `c.get("canvasSlug")` for runtime), both set by the gateway/role
middleware from the **server-side** auth + routing context — never a client header. A
client cannot dodge or poison another user's bucket. *Rationale:* §12.0 #1; the same
discipline as every other authz surface here.

**KTD-5 — Takedown stores ONE reason column on the canvas row; audit_log owns who/when.**
"Owner sees why" (R3) requires the reason to be readable by the owner in their dashboard, so
`disabled_reason` (text, null) lives on the `canvases` row — durable canvas state, not an
audit entry the owner can't query. **Who/when is NOT duplicated onto the row** (scope
review): `disabled_at`/`disabled_by` would strictly duplicate the `canvas_disable` audit
entry's `created_at`/`actor_id`; the admin view derives them from the audit log (or defers
the detail to the v1.1 audit-log viewer). `enable`/`restore` clear `disabled_reason`.
`disabled_reason` is projected **only for the owner/admin** (it's reached only via
`ownedCanvas`-gated management routes today; state the conditional explicitly so a future
shared/gallery view can't leak an operator's internal note — security review). The audit log
records `canvas_disable` (meta `{ reason }`) / `canvas_enable` with actor. Greenfield — a
one-column add, no backfill.

**KTD-6 — Admin routes reuse the 404-not-403 no-leak posture.** `requireAdmin` returns
**404** (not 403) for a non-admin hitting `/api/admin/*`, matching `ownedCanvas`'s
existence-non-confirmation pattern — an admin surface should not even confirm it exists to a
non-admin. *Rationale:* enumeration resistance (§12.1.4) + consistency with the codebase's
established no-leak idiom. (The capability/disabled 403s are different: those are *known*
resources the caller is *told* are off.)

**KTD-7 — `disabled` denial is content-negotiated, mirroring the existing 404 page.**
`serveCanvas`/`canvasAccess` already render a styled HTML page for content 404s
(`accept: text/html`) and JSON for programmatic clients. The disabled page follows the exact
same pattern — static, org-agnostic, no canvas data interpolated (nothing to escape/leak).
The runtime API (`/v1/c/:slug/*`) returns the typed `{ code: "DISABLED" }` 403, not HTML.
*Rationale:* reuse the proven pattern; keep the runtime envelope (`{ code }`) distinct from
the content surface.

---

## Implementation Units

Two phases: **Phase A (K — admin panel)** = U1–U6; **Phase B (L — hardening)** = U7–U10.
Within a phase, units are dependency-ordered. Phase B is independent of Phase A and could
interleave, but is sequenced after for a clean review narrative.

### U1. Schema: takedown reason column on `canvases`

**Goal:** Add the durable state a takedown needs so the owner can see *why* (R3, R12, KTD-5).

**Requirements:** R3, R12. **Dependencies:** none.

**Files:**
- `packages/shared/src/db/schema.sqlite.ts` — add `disabledReason` (text, null) to `canvases`.
- `packages/shared/src/db/schema.pg.ts` — identical column, pg builders (lockstep, dual-dialect doc).
- `drizzle/sqlite/0007_*.sql`, `drizzle/pg/0007_*.sql` — generated migrations (both dialects).
- `drizzle/{sqlite,pg}/meta/*` — generated snapshots/journals (commit all).
- `packages/shared/src/db/schema.test.ts` — parity test already diffs columns; confirm green (no new assertion needed unless adding index).

**Approach:** **One** column, not three — `disabled_at`/`disabled_by` would duplicate the
`canvas_disable` audit entry's `created_at`/`actor_id` (KTD-5, scope review); the admin view
derives who/when from the audit log. Mirror the existing nullable-column style (e.g.
`gallerySummary`). No index — read only when a row is already loaded by id/slug, never
filtered on. Generate **both** dialect migrations off this branch's base (`pnpm drizzle-kit
generate --config drizzle.sqlite.config.ts --name takedown_reason` and the pg config); use
whatever number drizzle picks (expected `0007`). Per the dual-dialect doc: a schema edit
alone leaves test DBs failing — the generated migrations are what `makeTestDb` applies.

**Patterns to follow:** the `0006_files` column-add migration pair; `gallerySummary`/
`galleryTags` nullable columns in `schema.sqlite.ts`.

**Test scenarios:**
- Schema-parity test stays green (both dialects have `disabled_reason`, same nullability).
- A repo insert + read round-trips `disabledReason` as null by default (covered transitively by U2's repo tests on both dialects).

**Verification:** `pnpm test` green on both dialects; `drizzle/{sqlite,pg}/0007_*.sql` exist
and each add the `disabled_reason` column.

---

### U2. Admin authz middleware + cross-owner repo methods

**Goal:** Server-side admin gate (R1, KTD-6) and the data access the admin panel needs:
cross-owner canvas list with enrichment, platform totals, restore, and disable/enable
transitions that honor the lifecycle instantly (R2, R3, R4, R7, R12). Also closes the
owner-self-rescue lifecycle hole by re-guarding `archive` (R12).

**Requirements:** R1, R2, R3, R4, R7, R12. **Dependencies:** U1.

**Files:**
- `apps/server/src/admin/authz.ts` — `requireAdmin()` middleware: 404 when `!c.get("user").isAdmin`.
- `apps/server/src/admin/authz.test.ts`
- `apps/server/src/db/repositories/admin.ts` — `listAllCanvases({status?, limit, cursor})` (cross-owner, newest-first, no `deleted` unless asked); `platformStats()` (canvas counts by status, user count, total storage bytes, top-N canvases by usage); `restore(id)` (guarded `deleted → active`, clears `deletedAt`); `setDisabled(id, {reason})` / `enable(id)` (guarded `active⇄disabled` transitions, set/clear `disabled_reason`).
- `apps/server/src/db/repositories/files.ts` — **net-new** `bytesByCanvas(ids[])` batched `groupBy(canvasId) coalesce(sum(sizeBytes),0)` aggregate (dual-dialect; not a `withLastDeploy` copy — the files table needs its own aggregate). Used for the admin list's size column.
- `apps/server/src/db/repositories/canvases.ts` — **re-guard** `archive(id)` to `WHERE id=? AND status='active'` (was `ne(status,'deleted')`) so an owner cannot archive a `disabled` row and reverse a takedown.
- `apps/server/src/db/repositories/admin.test.ts`, `canvases.test.ts`, `files.ts` test.

**Approach:** `requireAdmin` reads `c.get("user").isAdmin` (set by the gateway from
`config.adminEmails` at upsert — server-derived, never client). Repo methods follow the
existing `canvasesRepository` dual-dialect `as any` seam. `restore` mirrors `archive`'s
guarded-update shape (`WHERE id=? AND status='deleted'`, returns boolean). `setDisabled`/
`enable` are guarded `active⇄disabled` transitions (don't disable a deleted/archived row —
return false so the route 409s `NOT_ACTIVE`; archived-can't-be-disabled is a deliberate v1
constraint — an archived canvas already 404s publicly). `enable` clears `disabled_reason`.
**Archive re-guard (adversarial review):** narrowing `archive` to `status='active'` closes
the disabled→archived→active self-rescue; existing archive tests must still pass (archiving
an active canvas works) plus a new "archive of a disabled canvas → false" test.
`listAllCanvases` reuses the `withLastDeploy` batched **version** lookup for last-deploy, and
the new `bytesByCanvas` batched **files** aggregate for size (document per-page cost bound).
`platformStats` queries must **`coalesce(sum(...),0)` and wrap every aggregate in `Number()`**
(adversarial review): pg returns `sum` as a string and `sum()` over zero rows is `NULL` on
both dialects — an empty platform must report `0`, not `null`/`NaN`, and the two legs must
agree.

**Patterns to follow:** `canvasesRepository.archive`/`unarchive` (guarded transitions
returning boolean); `usage-events.ts` `Number(r.count)` coercion (the dual-dialect aggregate
trap); `managementRoutes.withLastDeploy` (batched enrichment); `ownedCanvas`'s 404-no-leak
posture for `requireAdmin`.

**Test scenarios:**
- `requireAdmin`: admin user → `next()` runs; non-admin user → **404** (not 403), handler never reached. Covers R1.
- `restore`: a `deleted` canvas → `active`, `deletedAt` cleared, returns true; a non-deleted canvas → false. Covers R4.
- `setDisabled`: an `active` canvas → `disabled` with reason set, returns true; a `deleted` **or `archived`** canvas → false. `enable`: `disabled → active`, clears `disabled_reason`. Covers R3, R12.
- **Archive re-guard (R12):** owner archive of a `disabled` canvas → returns false (status stays `disabled`); archive of an `active` canvas still succeeds (no regression).
- `listAllCanvases`: returns canvases from **multiple owners** (not owner-scoped), newest-first; `status` filter narrows; size (version bytes + `bytesByCanvas`)/usage/last-activity present and correct; deleted excluded unless requested.
- `platformStats`: counts by status, user count, total bytes, top-N-by-usage correct against a seeded fixture; **empty-platform case → `totalBytes === 0`** (number, not null) on **both dialects**.
- All repo tests run on **both dialects** (`describe.each(DIALECTS)`).

**Verification:** dual-dialect repo tests green; `requireAdmin` 404s non-admins; owner cannot
archive a disabled canvas; empty-platform stats return numeric zeros.

---

### U3. Admin settings service: model allowlist + global quota defaults

**Goal:** Manage and resolve platform policy — the AI model allowlist (R5) and global quota
defaults (R6) — on the existing `settings` key/JSON store, with a cached effective-quota
resolver wired into the primitives that exist (KTD-3, KTD-effective-quota).

**Requirements:** R5, R6. **Dependencies:** none (parallel with U1/U2).

**Files:**
- `apps/server/src/admin/settings-service.ts` — typed get/set over `settingsRepository` for keys `ai.models.allowlist` (string[]) and `quota.*` (numbers: `kv.keys.shared`, `kv.keys.user`, `files.bytes.canvas`, `files.bytes.file`, `ai.user.daily.usd`, `ai.canvas.monthly.usd`); `effectiveQuota(key)` (plain read, no cache); `effectiveModels()` (settings allowlist ?? `config.ai.models`).
- `apps/server/src/admin/settings-service.test.ts`
- `apps/server/src/routes/canvas-kv.ts` — read `KV_MAX_KEYS_*` via the resolver (fallback to the existing constants).
- `apps/server/src/canvas/files-service.ts` — read file-byte limits via the resolver (fallback to existing constants).

**Approach:** Thin typed wrapper over `settingsRepository` (Json store). `effectiveQuota` is a
**plain per-request read** — `settings ?? config ?? constant` — **no in-process cache** (a
cache is premature at D13 / 50–150-user scale; the settings read is a PK lookup on a tiny
table, and the stale-window + invalidation logic isn't worth the complexity — scope review;
add a cache later only if instrumentation shows it matters). Zod-validate inputs at the
service boundary (allowlist = non-empty string[]; quotas = positive finite numbers) so a bad
admin write can't poison enforcement. Keep wiring minimal: KV key-count limit + file
size/bytes limit read the resolver; AI quotas are stored for M9 to consume (config holds the
defaults). `effectiveModels()` returns **plain model-ID strings** (no provider prefix —
BUILD_BRIEF D12 reserves provider-qualified shape for later); document this as the U3↔M9
contract so M9 knows the stored format. Per-canvas/per-user *overrides* are v1.1 (§6.10.7) —
this unit ships global defaults only.

**Patterns to follow:** `settingsRepository` (the store this builds on); the
`KV_MAX_KEYS_*`/file constants as fallbacks; `capabilityGlobals(config)` (one Config→policy
translation point).

**Test scenarios:**
- `effectiveModels()`: returns settings allowlist when set; falls back to `config.ai.models` when unset; returns plain strings (no provider prefix). Covers R5.
- `effectiveQuota("kv.keys.shared")`: settings value overrides; unset → config/constant fallback. Covers R6.
- Validation: a non-positive quota or empty allowlist is rejected at the service boundary (throws / returns error), leaving the stored value unchanged.
- KV route honors an admin-lowered `kv.keys.shared` (integration-style: set to 1 via service, second new key → KEY_LIMIT). Run on both dialects where it touches the DB.

**Verification:** service tests green; an admin-set KV key limit is enforced by the live KV route.

---

### U4. Admin API routes (`/api/admin/*`)

**Goal:** Expose the admin operations behind `requireAdmin`, audited (R1–R7, R10).

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R10. **Dependencies:** U2, U3.

**Files:**
- `apps/server/src/routes/admin.ts` — Hono router mounted at `/api/admin`: `GET /canvases` (list, paginated, `status` filter); `GET /overview` (platform stats); `POST /canvases/:id/disable` ({reason}); `POST /canvases/:id/enable`; `POST /canvases/:id/restore`; `GET|PUT /settings/models`; `GET|PUT /settings/quotas`. All mutations `requireSameOrigin`. Every mutation `recordAudit`.
- `apps/server/src/routes/admin.test.ts`
- `apps/server/src/app.ts` — mount `app.route("/api/admin", adminRoutes({...}))` after `/api/canvases`, behind the gateway. **(shared file — integration conflict-watch)**

**Approach:** Router shape mirrors `managementRoutes`: `requireAdmin` applied to the whole
router; `requireSameOrigin` on mutations; `{ error }` envelope (management surface, not the
runtime `{ code }`). Disable/enable/restore call the U2 repo methods and `recordAudit` with
new actions `canvas_disable` (meta: `{ reason }`), `canvas_enable`, `canvas_restore`, plus
`admin_settings_update` (meta: `{ keys }`) for allowlist/quota writes. Reason is required +
length-bounded (Zod). A disable on a non-active canvas (archived/deleted) returns a clean
**409 `NOT_ACTIVE`** from the guarded repo boolean (mirror `unarchive`'s `NOT_ARCHIVED` 409) —
archived-can't-be-disabled is a deliberate v1 constraint (the archived URL already 404s
publicly); restore of a non-deleted canvas → 409.
**`disabledReason` projection (security review):** extend `publicCanvas` to include
`disabledReason`, but project it **only when the caller is owner or admin** — make it a
conditional field, not a flat expansion, so a future shared/gallery view can't leak an
operator's internal note to a non-owner. Today `publicCanvas` is reached only via
`ownedCanvas`-gated routes (owner/admin), so this is belt-and-suspenders, but state it
explicitly. The admin route is distinct from the existing draft `POST /api/canvases/:id/
restore` (revert-to-version) — this one is `POST /api/admin/canvases/:id/restore`
(un-soft-delete); different mount base, no runtime collision, but name the dashboard client
fn distinctly (e.g. `adminRestoreCanvas`) to avoid confusion (adversarial FYI).

**Patterns to follow:** `managementRoutes` (router composition, same-origin, audit calls,
`publicCanvas` projection — extend with the conditional `disabledReason`); `unarchive`'s
guarded-transition 409.

**Test scenarios:**
- **Authz (R1):** non-admin user → **404** on every `/api/admin/*` route (list, overview, disable, settings); admin user → 200. Build one app with the dev user in `adminEmails` and one without to flip `isAdmin` server-side.
- **Disable (R3, R12):** admin disables canvas A with reason → A.status `disabled`, reason stored; audit has `canvas_disable` with actor + reason. Disable of an **archived** canvas → 409 `NOT_ACTIVE`.
- **Enable:** disabled → active; `disabled_reason` cleared; audit `canvas_enable`.
- **Restore (R4):** admin restores a soft-deleted canvas → active; audit `canvas_restore`. Restore of a non-deleted canvas → 409.
- **`disabledReason` projection (security):** the owner's `GET /api/canvases/:id` on their disabled canvas returns `disabledReason`; a **non-owner** gets 404 (no projection at all — `ownedCanvas` gates it). Asserts the reason never reaches a non-owner.
- **List (R2):** returns canvases across multiple owners with owner/status/size/usage/last-activity; `status=disabled` filter works.
- **Overview (R7):** returns totals + top canvases.
- **Settings (R5/R6/R10):** PUT models/quotas persists + audits `admin_settings_update`; GET reflects it; invalid body → 400.
- **Same-origin:** a cross-site mutation (forged `sec-fetch-site: cross-site`) → 403.

**Verification:** admin route suite green (sqlite-only per dashboard-spa doc's HTTP-route-test
convention); non-admin 404s proven; disable rejected on archived; reason never leaks to non-owner.

---

### U5. Disabled page (content path) + runtime API disabled handling

**Goal:** A taken-down canvas's public URL shows a styled "disabled" page; the owner learns
why from the dashboard; the runtime API returns the typed 403 (R3, R12, KTD-7).

**Requirements:** R3, R12. **Dependencies:** U1 (reason column), U2/U4 (so a canvas can be disabled).

**Files:**
- `apps/server/src/canvas/disabled-page.ts` — **new** standalone `disabledPage()` HTML + a content-negotiation helper, mirroring `notFoundPage` (no canvas data interpolated). Kept here (not in `serve.ts`) so `authorization.ts` imports it without an awkward `authorization.ts → serve.ts` dependency (feasibility review).
- `apps/server/src/canvas/authorization.ts` — `canvasAccess`: branch on `decision.reason === "disabled"` (the only 403 the decision table produces) and render the content-negotiated disabled page (HTML for browsers, JSON `{ error: "disabled" }` otherwise) instead of the current bare JSON 403. **Decision table unchanged** (only the deny *rendering* changes).
- `apps/server/src/canvas/authorization.test.ts` — extend.
- `apps/server/src/routes/canvas-api.ts` — confirm the runtime pipeline already returns `{ code: "DISABLED" }` via `decideCanvasAccess` (it does — `decision.reason.toUpperCase()`); add a regression test, no code change expected.

**Approach:** The `disabled` branch in `decideCanvasAccess` already fires before owner/admin
(verified — `authorization.ts`), so the public URL is opaque to **everyone including the
owner AND admin** (KTD-7, §12.0 #5 — no admin exemption on the access decision; an admin who
needs to inspect content does it before takedown or via a future explicit preview surface,
not the slug). The owner sees the *specific* reason in their dashboard (the owner/admin-gated
`disabledReason` projection from U4). The page is static and org-agnostic — the reason is
**not** interpolated into the public page (owner-only via the authed dashboard, no leak of
operator notes). Content negotiation copies the `notFound` helper exactly; security headers
via the U8 `baseSecurityHeaders` helper.

**Patterns to follow:** `serve.ts` `notFound`/`notFoundPage` (content negotiation + static
page + headers); the existing `disabled` branch in `decideCanvasAccess`.

**Test scenarios:**
- A `disabled` canvas, browser `Accept: text/html` → 403 + HTML page (contains "disabled", no reason text, no canvas internals).
- Same canvas, programmatic (`Accept: application/json`) → 403 `{ error: "disabled" }`.
- **Admin is not exempted (§12.0 #5):** an **admin** GET of the disabled canvas slug → 403 disabled page (NOT the live content); admin runtime API `/v1/c/:slug/kv/...` on it → 403 `{ code: "DISABLED" }`. Regression-locks that disabled fires before owner/admin.
- Runtime API on a disabled canvas (non-admin viewer) → 403 `{ code: "DISABLED" }`. Covers R12.
- Lifecycle (R12): disable takes effect on the next request (no cached grant) — disable, then immediately request → already 403.

**Verification:** content + runtime suites green; disabled page renders for browsers, typed
403 for API, admin not exempted.

---

### U6. Dashboard admin UI

**Goal:** The admin-only dashboard surface: all-canvases table with takedown/restore, model
allowlist + quota-defaults editors, and the platform usage overview (R1–R7).

**Requirements:** R1, R2, R3, R4, R5, R6, R7. **Dependencies:** U4.

**Files:**
- `apps/dashboard/src/routes/admin.tsx` — all-canvases table (owner/status/size/usage/last-activity) + disable(reason)/enable/restore actions (confirm-and-await, not optimistic — irreversible-ish ops).
- `apps/dashboard/src/routes/admin.settings.tsx` — model-allowlist editor, quota-defaults form, platform overview cards.
- `apps/dashboard/src/components/AdminCanvasTable.tsx`
- `apps/dashboard/src/lib/api.ts` — admin API client fns + types. **(shared file — conflict-watch)**
- `apps/dashboard/src/lib/queries.ts` — admin queries/mutations (react-query). **(shared file — conflict-watch)**
- `apps/dashboard/src/router.tsx` — add `/admin` + `/admin/settings` routes; gate the nav entry on `me.isAdmin`. **(shared file — conflict-watch)**
- `apps/dashboard/src/app-layout.tsx` — conditional "Admin" nav link when `me.isAdmin`.
- `apps/dashboard/src/test/admin.test.tsx`

**Approach:** Reuse the SPA conventions (dashboard-spa doc): routes live at `/admin`
(**not** `/c/`, `/api/`, `/v1/`, `/auth/`); the "Admin" nav link renders only when
`/api/me` returns `isAdmin` (the **server** is authoritative — hiding the link is UX only,
the API enforces). Mutations are confirm-and-await (reuse `ConfirmDialog`/`HoldButton`);
takedown opens a reason dialog. Token-first styling (CSS vars), no hard-coded colors. The
admin client mirrors the local capability taxonomy approach — no `@canvas-drop/shared`
import in the bundle. Disable reason field + restore use the same `ApiError`/auth-expiry
handling in `api.ts`.

**Patterns to follow:** `routes/archived.tsx` + `CanvasList`/`CanvasDetail` (list + detail
shape); `ConfirmDialog`/`HoldButton` (irreversible-action UX); `api.ts` auth-expiry branch;
`router.tsx` route registration avoiding reserved prefixes.

**Test scenarios:**
- Admin nav link renders when `me.isAdmin`, hidden otherwise.
- All-canvases table renders owner/status/size/usage/last-activity rows from a mocked admin list.
- Takedown flow: click → reason dialog → confirm → calls `POST /api/admin/canvases/:id/disable` with reason; row reflects `disabled`.
- Restore flow: calls `adminRestoreCanvas` → `POST /api/admin/canvases/:id/restore`; row leaves the deleted view. (Client fn named distinctly from the draft revert-to-version `restore`.)
- **Owner sees why (R3, adversarial review):** the **owner's own** canvas list/detail renders a `status=disabled` canvas with its `disabledReason` text — the requirement's owner-facing surface, not just the admin table. Confirm the owner list UI doesn't filter out non-`active` statuses client-side.
- Settings: editing the allowlist / a quota default issues the PUT; overview cards render totals.
- `Test expectation`: dashboard jsdom suite (its own vitest config), not the dual-dialect node suite.

**Verification:** `pnpm --filter @canvas-drop/dashboard test` green; admin UI gated on
server `isAdmin`; the owner sees the takedown reason on their own canvas.

---

### U7. Rate limiting: store + classifier + middleware

**Goal:** Broad route-class rate limiting on every runtime + management API class, keyed by
server-derived identity, auto-covering future primitives; plus the §12.3 credential-surface
classes (login, password-gate) (R8, KTD-1/2/3/4).

**Requirements:** R8. **Dependencies:** none (Phase B; independent of A).

**Files:**
- `apps/server/src/http/rate-limit.ts` — `inProcessRateLimitStore()` (fixed-window `Map` + lazy expiry + periodic sweep + defensive key-count cap); a small exported store-shape type for test injection; `classifyRequest(c) → null | { class, key, limit, windowMs }` (**path-first**); `rateLimit(store, config)` middleware.
- `apps/server/src/http/rate-limit.test.ts`
- `apps/server/src/app.ts` — construct a default in-process store (optional `rateLimitStore` dep so test harnesses needn't all pass one) and mount `rateLimit(...)` **after** the gateway + role middleware (so `user`/`canvasSlug` are server-resolved), before route handlers. **(shared file — middleware order! conflict-watch)**
- `apps/server/src/routes/deploy-api.ts` — apply the `deploy` throttle (10/min, keyed by **canvasId** resolved *after* `authCanvas` verifies the Bearer key) per mutating handler — NOT router middleware (no `user`/canvas in context until the key is verified).
- `apps/server/src/auth/routes.ts` (or the app mount) — login throttle on `/auth/*` (5/min keyed by conninfo socket-peer IP, pre-gateway).
- `apps/server/src/canvas/password-gate.ts` — password-gate throttle on the gate POST (5/min keyed by user+canvas).
- `packages/shared/src/config/env.ts` — rate-limit config (values + master `enabled` flag — see U8). **(shared file — conflict-watch)**

**Approach:** `classifyRequest` is pure and **path-first** (KTD-2 — `role` does NOT separate
`/api/*` from the SPA; `resolveRequest` makes both `dashboard`): match `/v1/c/<slug>/ai/*` →
`ai` (10/min, key `ai:user`); other `/v1/c/<slug>/*` → `canvas` (60/min, key
`canvas:user:slug`, where slug is the **pre-authorization** `canvasSlug` from `resolveRequest`);
`path.startsWith("/api/")` → `management` (60/min, key `mgmt:user`) — this **includes** session
publish/rollback/deploy (same-origin + session-gated, 60/min is right-sized); else `null`
(static content, SPA, `/sdk/v1.js`, `/healthz`, `/auth` — not API classes). **No `deploy`
branch in the broad classifier** (adversarial/feasibility: the broad middleware is
post-gateway; the strict 10/min deploy limit belongs on the pre-gateway Bearer path where
runaway agents actually hit, keyed by canvasId). The store's `hit` returns `{ allowed,
remaining, resetAt, retryAfterSec }`. On breach: `429` + `Retry-After` + `X-RateLimit-*`;
envelope `{ code: "RATE_LIMITED" }` for the runtime class, `{ error: "rate_limited" }` for
management/deploy. A `config.rateLimit.enabled` master flag (default true) lets tests opt out;
limits from config (KTD-3). Periodic sweep (interval timer; no `Math.random`/`Date.now`
issues — uses the runtime clock) prunes expired buckets; a **defensive key-count cap** bounds
the non-existent-slug-spray vector (the one realistic unbounded-key case, since `canvas`
buckets key on the unvalidated path slug) — evict oldest-expired / fail-safe past the cap.
Store created per `buildApp` (per-test isolation). The Bearer deploy throttle, login throttle,
and password-gate throttle are the **three mount points outside** the broad middleware
(documented, not gaps).

**Patterns to follow:** `createMiddleware<AppEnv>` factories; `requireSameOrigin` (pure-check
+ middleware pair); audit-log fire-and-forget discipline (sweeps never block requests);
`getConnInfo`/`c.get("clientIp")` for the login class (socket peer, never XFF).

**Test scenarios:**
- **Runtime breach (R8):** N+1 calls to `/v1/c/:slug/kv/...` within the window as one user → the (limit+1)th returns **429** `{ code: "RATE_LIMITED" }` + `Retry-After`. *Mandated by the task.*
- **Management breach (R8):** N+1 calls to `/api/canvases` → **429** `{ error: "rate_limited" }`. *Mandated by the task.*
- **Per-user isolation:** two different users each get their own bucket — user B not throttled by user A's spend (key uses server-derived `user.id`, never a header).
- **Per-canvas isolation:** the same user hitting two different canvases' runtime APIs has independent `canvas` buckets.
- **Window reset:** after `windowMs` (inject a fake clock or use a tiny window), the bucket resets and requests pass.
- **Skip classes:** static canvas content, `/sdk/v1.js`, `/healthz`, `/auth`, and the SPA shell → classify `null`, not throttled.
- **AI class auto-coverage:** `/v1/c/:slug/ai/chat` classifies as `ai` at 10/min even though the route 404s today (proves future auto-coverage).
- **Disabled flag:** `rateLimit.enabled=false` → nothing throttled.
- **Deploy throttle:** Bearer deploy with a valid key past 10/min/canvas → 429; an otherwise-identical request **without a valid key → 401** (key validation runs first; not 429, not unthrottled-through).
- **Login class:** >5 `/auth/login` hits/min from one IP → 429; a different IP unaffected.
- **Password-gate class:** >5 gate POSTs/min for one user+canvas → 429.
- **Key-count cap:** past the configured cap, new keys evict the oldest-expired entry (or fail safe) rather than growing unboundedly.

**Verification:** rate-limit suite green; runtime + management + deploy + login + password-gate
429s proven; key-cap enforced; existing suites still green (default limits high enough not to trip).

---

### U8. Config + security-headers baseline review

**Goal:** Rate-limit config surface with §12.3 defaults + `.env.example` (R8), and a
consolidated §12.4 security-headers baseline across every response surface (R9).

**Requirements:** R8, R9. **Dependencies:** U7 (consumes the config).

**Files:**
- `packages/shared/src/config/env.ts` — add `CANVAS_DROP_RATELIMIT_ENABLED` (bool, default true) and per-class `*_PER_MIN` vars (canvas 60, ai 10, deploy 10, management 60, login 5, password-gate 5) → `config.rateLimit`. **(shared file — conflict-watch)**
- `packages/shared/src/config/env.test.ts` — defaults + override parsing.
- `.env.example` — document every new var.
- `apps/server/src/http/security-headers.ts` — `baseSecurityHeaders(headers)` helper (nosniff, Referrer-Policy, COOP) + a fallback global middleware that applies the baseline to **`c.json()`/`c.res`-mutable responses** (API/admin/runtime).
- `apps/server/src/http/security-headers.test.ts`
- `apps/server/src/app.ts` — mount the fallback baseline-headers middleware. **(shared file — conflict-watch)**
- `apps/server/src/canvas/serve.ts`, `apps/server/src/canvas/disabled-page.ts`, `apps/server/src/canvas/file-serving.ts`, `apps/server/src/dashboard/serve-spa.ts`, `apps/server/src/routes/draft-api.ts` — call `baseSecurityHeaders(headers)` **inside the handler** when building their own `new Headers(...)`/`new Response(...)` (these bypass outer-middleware header mutation — feasibility review). Add **COOP** to the canvas-content headers (the real gap).

**Approach (corrected audit — feasibility/adversarial review):** the inline header sets on
the canvas-content, SPA, file-serving, and draft-preview paths build their **own** `Response`/
`c.body(...)` objects, which an outer `c.header()` after `next()` does **not** merge into. So
a single "global middleware covers every response" claim is false for those surfaces. The
**shared `baseSecurityHeaders(headers)` helper is the source of truth, called inside every
self-Response handler**; the global middleware is a **fallback for `c.json()` API/admin
responses only** (which previously had no baseline). On COOP: it is **already present on the
SPA document** (`serve-spa.ts`) — it is **not** globally absent; the real gaps are
canvas-content (`serve.ts` `securityHeaders`) and the JSON/API responses. Keep the strict
dashboard CSP and canvas `frame-ancestors 'none'` exactly as-is (don't loosen) — those stay
as per-surface extras layered on the helper. §12.3 limit values become config so they're
documented + overridable (admin-tunable rate limits remain a follow-up, KTD-3).

**Patterns to follow:** the `bool`/`num`/`csv` config transforms in `env.ts`; the existing
`securityHeaders`/`SECURITY_HEADERS` constants in `serve.ts`/`serve-spa.ts` (consolidate into
the helper, don't duplicate); `requestLogger` global-middleware mount shape (for the JSON
fallback only).

**Test scenarios:**
- Config: rate-limit defaults parse to §12.3 values (incl. login 5, password-gate 5); env overrides apply; an invalid bool/num fails loud (existing `bool`/`num` behavior).
- `baseSecurityHeaders`: sets nosniff + Referrer-Policy + COOP.
- An API JSON response (e.g. `/api/canvases`, `/api/admin/overview`) carries the baseline headers (previously absent).
- The canvas content response carries `frame-ancestors 'none'` + nosniff **+ COOP** (COOP newly added; no regression on the rest).
- The SPA document still carries its strict CSP + its existing COOP (no regression).
- The disabled page + file-serving responses carry the baseline (helper called in-handler).
- `.env.example` documents every new var (spot-check).

**Verification:** config + headers tests green; every self-Response surface calls the helper;
JSON API carries the baseline; canvas content gains COOP; CSP/frame-ancestors unchanged.

---

### U9. Audit-log completeness for primitive + admin surfaces

**Goal:** Close the §12.1.8 gaps the new + existing primitive surfaces left (R10).

**Requirements:** R10. **Dependencies:** U4 (admin actions audited there); this unit covers
the **primitive** surfaces + a completeness pass.

**Files:**
- `apps/server/src/routes/canvas-kv.ts` — audit KV **mutations** (set/delete/increment) — distinct from the fire-and-forget `usage_events` metering, which is for stats, not the audit trail. §12.1.8 lists "canvas API mutations".
- `apps/server/src/routes/canvas-files.ts` — audit file upload/delete.
- `apps/server/src/audit/audit-log.test.ts` — extend / new assertions.
- `apps/server/src/routes/canvas-kv.test.ts`, `canvas-files.test.ts` — assert audit rows.
- (admin actions already audited in U4.)

**Approach:** Add `recordAudit` calls (fire-and-forget, same as existing usage) on the KV/
files **mutating** ops with `actorId = user.id`, `targetId = canvasId`, action e.g.
`kv_mutation` (meta `{ op, scope }`) and `file_upload`/`file_delete`. Reads are **not**
audited (volume; §12.1.8 says mutations) — document that decision. Distinguish clearly from
`usage_events`: audit = security trail (who did what), usage_events = metering (how much).
This is calibrated to the trust model — audit the mutations that matter for an internal
incident review (§12.6 "audit usefulness for trust-first shared apps"), not every read.
Verify the §12.1.8 list is covered: auth events (gateway ✓), canvas CRUD (management ✓),
key/slug regen (✓), deploys (✓), password attempts (✓), share/revoke/expiry (✓), **canvas
API mutations (this unit)**, **admin actions (U4)**, AI/realtime (M9, n/a).

**Patterns to follow:** `managementRoutes` audit calls (`recordAudit({ action, actorId,
targetId, meta })`); the fire-and-forget `meter()` helper in `canvas-kv.ts` (mirror its
shape for the audit call); `audit-log.ts` best-effort discipline.

**Test scenarios:**
- KV `set`/`delete`/`increment` each write an audit row with actor + canvas + op; a `get`/`list` does **not** (reads unaudited by design).
- File upload + delete each write an audit row.
- Audit writes are fire-and-forget: a forced audit-repo failure does **not** fail the KV/file request (mirror the existing swallow-and-log behavior).
- Completeness assertion: after a representative admin + primitive session, the audit log contains the §12.1.8 action set (spot-check the new actions).

**Verification:** primitive mutations audited; reads not; request path never fails on an
audit error.

---

### U10. Trusted-proxy / IAP §12.5 verification hardening

**Goal:** Harden and prove the §12.5 anti-impersonation edge — strip inbound identity
headers at our trust boundary, log untrusted-header presence, and test the rejection paths
first (R11, §12.0 #1).

**Requirements:** R11. **Dependencies:** none.

**Files:**
- `apps/server/src/auth/proxy.ts` — defense-in-depth logging: in JWKS mode, when the JWT is **absent or fails verification** and an identity header is nevertheless present, **log** the stray-header presence as a security event. Crucially this must fire in the **JWT-absent AND JWT-failure (`catch`) paths** (security review) — the failure path is the dangerous downgrade-probe case, and the current code logs neither. (The untrusted-source header case is already logged.) Confirm the two trust paths remain mutually exclusive (no JWT → no header fallback in JWKS mode).
- `apps/server/src/app.ts` — a small "strip inbound identity headers at our trust edge" note/guard: the proxy must **overwrite** these headers; we don't re-inject them. Document that header-stripping is the proxy's job (the app can't strip what arrives on the only ingress), and the app's defense is: only the configured `emailHeader`/`jwtHeader` are ever read, and only on the active trust path. **(shared file — conflict-watch; likely doc-only)**
- `apps/server/src/auth/proxy.test.ts` — rejection-path tests.

**Approach:** The §12.5 logic is already strong (mutually exclusive paths, socket-peer IP,
`/0` rejection — all from the foundation review). This unit is a **focused review + test
hardening** pass, not a rewrite: (1) confirm the JWKS path never falls through to headers
(test: JWKS configured, request omits JWT but sets `X-Auth-Request-Email` → anonymous, **not**
the header identity); (2) confirm header path rejects an untrusted source IP (test: trusted
IPs set, request from a non-trusted peer with the email header → ignored + logged); (3) add
the JWKS-mode stray-header log; (4) document the header-stripping contract (the proxy
overwrites; the app reads only configured headers on the active path). Weight P0 — this is
invariant #1. Calibrate: don't add per-request anomaly detection (over-engineering vs the
trust model) — just make the existing gate's rejection paths explicit and tested.

**Patterns to follow:** `proxy.ts` existing `c.get("log")?.warn(... "ignored identity header
from untrusted source (§12.5)")`; the auth-invariant-checklist's "test the rejection paths
first" rule; the JWKS-vs-header mutual-exclusion already in `proxyStrategy`.

**Test scenarios:**
- **JWKS-mode no-downgrade (P0):** JWKS configured, request **omits** the JWT but sets the identity email header → resolves to **anonymous/null** (401), never the header identity. (The exact downgrade the foundation review caught — regression-lock it.)
- **JWKS-mode JWT-failure + stray header logged (P0, security review):** JWKS configured, JWT verification **fails** (bad sig/exp), email header also present → 401 AND a warning logs the stray-header presence (the downgrade-probe case the current code logs nowhere).
- **Untrusted source IP (P0):** trusted-IP header mode, identity header present but socket peer **not** in `trustedProxyIps` → identity ignored, warning logged, 401.
- **Trusted source IP happy path:** header mode, peer in `trustedProxyIps` → identity resolved.
- **Socket peer, not XFF:** the gating IP is the conninfo socket peer, never `X-Forwarded-For` (existing guarantee — assert it).

**Verification:** §12.5 rejection paths green; no JWKS→header downgrade; untrusted-source
headers ignored + logged.

---

## Scope Boundaries

**In scope (M7 / areas K + L):** everything in R1–R12 above.

### Deferred to Follow-Up Work (plan-local sequencing)
- **Live admin-tunable rate-limit values** (settings-backed read on the hot rate-limit path). M7 ships config/env-driven limits (KTD-3); the admin panel manages *quota* defaults, not rate-limit req/min. Clean follow-up.
- **Per-canvas / per-user quota overrides** (§6.10.7, explicitly v1.1). M7 ships global defaults only.
- **Audit-log viewer UI** (§6.10.8, v1.1 — the log itself is v1 and complete after U9).
- **User management** (block user, view a user's canvases — §6.10.9, v1.1).
- **Multi-process rate-limit / quota coordination** (shared store). §9.7 is single-process; both the rate-limit store and the (uncached) quota resolver are correct only at single-process scale — flagged for the M10 deploy work, not built here.

### Out of scope (other milestones — not this product increment)
- Deployment, backup/restore, load testing, OSS packaging (M10).
- AI primitive, realtime primitive, gallery (M8/M9) — the model allowlist + AI quota defaults are *managed* here but *consumed* when AI ships.
- Multi-process / shared (Redis) rate-limit store — §9.7 is single-process; the interface allows it later (KTD-1) but it isn't built.

---

## System-Wide Impact

- **`apps/server/src/app.ts`** is the integration hot spot: new middleware (rate limit,
  baseline headers) and a new route mount (`/api/admin`). **Middleware order matters** —
  rate limit after gateway+role, baseline headers early. Flagged for integration conflict-watch.
- **Dashboard shared files** (`router.tsx`, `lib/api.ts`, `lib/queries.ts`, `app-layout.tsx`)
  gain admin entries — conflict-watch against parallel dashboard work.
- **Schema/migrations** (`schema.{sqlite,pg}.ts`, `0007_*`, `schema.test.ts`) — one column add,
  both dialects.
- **`publicCanvas` projection** (`management.ts`) extended with `disabledReason`/`disabledAt`/
  `disabledBy` — consumed by the owner dashboard + admin list.
- **`docs/solutions/`** — add an M7 learnings doc (rate-limit seam, admin authz no-leak, §12.5
  test hardening) + update the index. Conflict-watch on `docs/solutions/README.md`.
- **Path-mode admin residual (security review):** in **path mode** the admin mutation
  endpoints (`/api/admin/*`) share an origin with canvases, so a canvas XSS could trigger an
  admin action if the victim is an admin (same `requireSameOrigin`-passes residual §12.2
  already documents for management routes — `Sec-Fetch-Site` + `SameSite` cookies are the
  mitigations, not elimination). No new code; surfaced so the code reviewer weighs it and the
  `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE` docs can mention the admin surface. Subdomain mode
  (the recommended multi-user production config) is unaffected.
- **Affected parties:** platform operators (new admin powers), canvas owners (takedown
  visibility, throttling on their canvases' APIs), and the M9 AI work (consumes the allowlist
  + quota defaults this lays down).

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Rate limiter trips existing tests (many build their own app + hammer endpoints) | Default limits are §12.3 values (60/min) — far above any test's call count; `rateLimit.enabled` flag + per-`buildApp` store give per-test isolation. Run the full suite per unit. |
| Middleware-order mistake in `app.ts` defeats keying (user not yet resolved) | Mount rate limit strictly **after** gateway + role middleware; test asserts per-user isolation (proves `user.id` is in the key). |
| §12.5 regression (the downgrade/untrusted-IP traps from the foundation review) | U10 regression-locks both with explicit rejection-path tests incl. the JWT-failure stray-header log; weighted P0. |
| Disabled-page leaks operator reason to non-owners | Reason is owner/admin-only via the conditional `publicCanvas` projection (`ownedCanvas`-gated; non-owner 404s); the **public** page interpolates no canvas data (KTD-5/KTD-7). Test asserts non-owner never receives `disabledReason`. |
| Owner self-rescues from a takedown (archive→unarchive a disabled canvas, §12.0 #5) | Re-guard `archive` to `status='active'` only (U2); test: owner archive of a disabled canvas → rejected. |
| Dual-dialect drift on the new column / admin queries | Generate both migrations; parity test; admin repo tests run `describe.each(DIALECTS)`; keep stats queries dialect-portable. |
| Cross-owner admin list / stats N+1 or heavy scan | Batch enrichment (reuse `withLastDeploy`); paginate; document the per-page cost bound. Trusted-org scale (D13) is small. |

**Dependencies:** U1→U2→U4→U5/U6; U3→U4; Phase B (U7–U10) independent of Phase A. The
`ce-code-review` pass (step 4 of the round) gates the branch, weighted hard against §12.0
(admin authz, takedown lifecycle, §12.5).

---

## Verification Strategy

- **Per unit:** `pnpm typecheck && pnpm lint && pnpm test` (both dialects) green before the
  next unit. One commit per unit.
- **Mandated coverage** (from the round brief): admin authz (admin-only; 404/403 for
  non-admins), takedown honoring the §12 lifecycle, trusted-proxy §12.5 paths, and rate-limit
  enforcement (limit hit → 429) covering **a runtime route AND a management route**.
- **Migrations:** both dialects regenerated off this branch's base.
- **Final:** `ce-code-review` on the branch; fix everything real with regression tests,
  §12.0-weighted; re-run the full gate green. Leave the branch committed, gates green, plan
  status active — do **not** push/PR/merge.

---

## Sources & Research

- `BUILD_BRIEF.md` §6.10 (admin panel), §6.11 (security/observability/ops), §12.0 (threat
  model + hard invariants), §12.3 (rate limits/quotas), §12.4 (headers), §12.5 (trusting the
  proxy), §16 M7.
- `docs/solutions/2026-06-13-auth-invariant-checklist.md` — §12 failure modes + the
  "calibrate to the trust model" guidance (weighting of findings).
- `docs/solutions/2026-06-13-canvas-primitives-runtime-api.md` — the `/v1/c/:slug/*` seam +
  the route classes to throttle; metering vs audit distinction.
- `docs/solutions/2026-06-13-dashboard-spa-patterns.md` — SPA route conventions (avoid
  reserved prefixes), api.ts auth-expiry, confirm-vs-optimistic, jsdom test config.
- `docs/solutions/2026-06-13-canvas-capability-model.md` — the guard seam + server-authoritative
  effective state (mirrors the admin "server is authoritative, UI is hint" posture).
- `docs/solutions/2026-06-13-dual-dialect-drizzle-seam.md` — column-add → both-dialect
  migrations; parity test; `describe.each(DIALECTS)`.
