# Plan 002 (2026-06-14) — Primitives showcase + admin-managed AI config

**Status:** implemented (this branch: `worktree-feature-polish-4`)
**Milestone:** consolidation over M6–M9 (primitives) + M7 admin surface.

## Context

The AI (H) and realtime (R) primitives were already built and unit-tested (plan 009 / M9) but had never been exercised as a real canvas in a browser, and there was no example canvas in the repo. This round (1) ships a polished, unbranded **primitives showcase** that exercises all five primitives end-to-end, and (2) — after the showcase surfaced that the AI provider key was env-only — generalizes admin settings into a **unified Configuration view** where the AI provider key and model allowlist are admin-managed (DB overrides env), never exposed to the browser.

## Delivered

### 1. Showcase canvas — `examples/showcase/`
- One-page `index.html` + `styles.css` + `js/{lib,identity,kv,files,ai,realtime,main}.js`, unbranded, light/dark, with explanatory copy + "show the code" snippets.
- Exercises identity (`me`), KV (shared counter + per-user note), files (upload/list/delete + preview), AI (streamed chat), realtime (presence + broadcast + live poll). Each section degrades on its own via `err.code` (graceful "disabled" cards).
- Dev seed `apps/server/scripts/seed-showcase.ts` (`pnpm seed:showcase`): idempotent, deploys the folder as a live canvas `showcase` owned by the dev user with backend + all caps on. Reads root `.env` via `process.loadEnvFile`.
- **Fix (real gap found):** the served SDK (`/sdk/v1.js`) was 503 under `pnpm dev` because the SDK package had no `dev` build. Added a watching `dev` script to `packages/sdk/package.json` so `pnpm dev` produces the bundle out of the box. Verified identity/KV/files/realtime live in the browser.

### 2. Admin-managed AI config + unified Configuration view
- **AI provider key in the DB** (`admin/settings-service.ts`): `effectiveApiKey` (DB override ?? env), `aiEnabled`, `getApiKeyStatus` (write-only — only configured/source/last4, never the raw key), `setApiKey`/`clearApiKey`. The provider is built per request from the effective key (`anthropicProvider({apiKey, baseUrl})` + `makeAiProvider` factory); the capability gate resolves `aiEnabled` per request (`requireCapability` gained an async globals override). Management's `effective` capability view reflects the runtime key too.
- **Model allowlist now actually enforced**: `canvas-ai.ts` validates against `settings.effectiveModels()` (was reading env `config.ai.models`, ignoring the admin override).
- **Config registry** (`admin/config-fields.ts`): every setting = one descriptor (env var, group, secret?, editable?, `fromConfig`). One resolution rule everywhere: **DB override ?? env ?? default**. `setEnvVars()` (shared) attributes source (database/environment/default) without a second `process.env` reader.
- **Unified view**: `GET /api/admin/config`, `PUT/DELETE /api/admin/config/:key`; dashboard `admin.settings.tsx` → grouped Configuration page (source badges, secret mask + last4, edit/clear). **Editable this round:** AI key, AI models, AI/KV/file quotas. **Read-only (shown for transparency):** realtime toggle, rate limits, admin emails, allowed domains, all structural/secret settings.

### Deferred (follow-up)
Live-editing **admin emails / allowed email domains / rate limits** — they're read on the auth + rate-limit hot paths (§12 invariant surface). The registry marks them read-only; the effective-resolver seam (`effectiveRealtimeEnabled`) is in place. Wiring their enforcement needs dedicated auth tests + a security review.

## Verification
- `pnpm lint && pnpm typecheck && pnpm test` (both dialects) green.
- New tests: `settings-service.test.ts` (effective key, write-only status, describeConfig masking/source, setConfigOverride validation + read-only rejection), `admin.test.ts` (GET/PUT/DELETE /config, key never echoed), dashboard `admin.test.tsx` (config edit + AI key write-only).
- Browser e2e: identity/KV/files/realtime verified live; AI verified by setting the key in the admin panel (no restart) → showcase AI section streams.
- `/ce-code-review` on the AI + config surfaces; findings fixed.
