---
title: Canvas backend primitives — the /v1/c/:slug runtime API seam, dual-dialect KV, and the served SDK
type: architecture
area: primitives
date: 2026-06-13
---

## What this is

The M6 build (plan 007): KV, Files, runtime Identity `me()`, and the browser SDK,
on a new canvas-facing `/v1/c/:slug/*` runtime API. Read this before adding the
**AI (H) or Realtime (R) primitives (M9)** — they hang off the same seam — and
before any KV/files/usage work.

## The runtime API seam (`apps/server/src/routes/canvas-api.ts`)

`/v1/c/:slug/*` is mounted in `app.ts` **after the auth gateway** (login on every
request, §12.0 #1) and **before** the role-keyed canvas-content chain. Per-request
pipeline, in order — a new primitive route just adds a `requireCapability` line:

1. **Resolve + authorize** the canvas from the path `:slug` via `findBySlug` +
   `decideCanvasAccess` (reuse — don't reinvent). Sets `c.get("canvas")`.
2. **Password gate** — `decideCanvasAccess` returns `needsPasswordGate`; if true,
   require a valid gate grant (`verifyGrant` + `GATE_COOKIE` from
   `password-gate.ts`) or 403 `PASSWORD_REQUIRED`. **This is easy to forget** — the
   content path runs the gate as separate middleware; the API must replicate it or
   a password-protected canvas's KV/files leak (caught in review, §12.0 #3).
3. **Cross-canvas isolation** (`http/canvas-api-isolation.ts`, §12.0 #4):
   - Subdomain mode: the SDK calls the **base host** (`canvases.example.com/v1/c/{slug}`,
     not the canvas subdomain — §9), so verify the request `Origin` host equals the
     slug's expected origin and emit **credentialed CORS** echoing only that origin
     (`Allow-Credentials: true`, `Vary: Origin`; never `*`). The `OPTIONS` preflight
     is the **only** pre-gateway exception (preflights carry no credentials).
   - Path mode: best-effort `Sec-Fetch-Site` + `Referer` (§12.2 reduced isolation).
     Use **segment-boundary** matching (`path === /c/${slug}` || `startsWith(/c/${slug}/)`),
     never substring — `app` must not match `/c/app-evil/` (caught in review).
4. **`requireCapability(cap, config)`** (plan 006) → typed 403 `CAPABILITY_DISABLED`.

`requireCanvas(c)` (in the isolation module) is the shared accessor every handler
uses instead of re-deriving `c.get("canvas")`.

## Dual-dialect KV atomic increment (the tricky bit)

The repo **deliberately avoids cross-dialect transactions** (sync better-sqlite3 vs
async pg). KV `increment` (R2, no-races) is therefore a **single-statement
`INSERT … ON CONFLICT DO UPDATE`** whose SET expression reads the row's own value —
atomic per-row on both engines, no transaction. The numeric expression is the one
dialect-specific bit, and KV values live in a JSON column:

- SQLite: `CAST(${value} AS REAL) + ${by}` — **REAL, not INTEGER** (INTEGER
  truncates floats; the integer form shipped first and the review caught the
  dual-dialect divergence). Integers still read back as integers.
- Postgres: `to_jsonb((${value}::text::numeric) + ${by})`.

A present non-numeric value is rejected via a pre-read guard (benign TOCTOU on the
error path only). Always add a **float** increment test, not just integer.

## Served SDK (`packages/sdk` + `serve-sdk.ts`)

- Built as an **esbuild IIFE bundle** (`browser-entry.ts` → `window.canvasdrop`),
  served at `GET /sdk/v1.js` **behind the gateway**. `dist/` is gitignored — CI's
  `pnpm build` produces it; the serve route 503s (non-stickily) until built.
- The browser SDK needs the **DOM lib**: exclude `packages/sdk` from the root
  `tsconfig.json` and give it its own DOM tsconfig + a line in the root `typecheck`
  script — exactly how the dashboard is handled.
- `detectContext` derives slug + apiBase from `location`; **preserve the port** in
  subdomain mode (`http://canvases.localhost:3000`), and the API base is the base
  host (first label stripped), not the canvas subdomain.
- `files.upload()` must return an **absolute** content url (the server's `url` is
  root-relative and would resolve to the canvas subdomain). Prefer `files.url(id)`.

## Conventions worth keeping

- **Runtime API error envelope is `{ code }`** in SCREAMING_SNAKE (CAPABILITY_DISABLED,
  KEY_LIMIT, QUOTA_EXCEEDED, NOT_FOUND, PASSWORD_REQUIRED…). The SDK maps by HTTP
  status first, then `code`. The management/dashboard API uses `{ error }` — keep the
  two surfaces distinct but each internally consistent.
- **Metering** (`usage_events`) is per-op, fire-and-forget (never reject the request
  path — mirror `audit-log.ts`). Growth is bounded by `pruneBefore`, wired into the
  `pnpm purge` sweep (rate limiting is deferred to M7). When you add a primitive, add
  its op type + a prune-friendly mind.
- **Quotas are best-effort** (check-then-write TOCTOU accepted on the trusted-org
  model) — document + test the chosen overshoot behavior, don't pretend it's atomic.

See also [[canvas-capability-model]] (the guard this builds on),
[[dual-dialect-drizzle-seam]] (schema + migration-generation), and
[[auth-invariant-checklist]] (§12 invariants upheld here).
