---
title: "feat: Canvas authoring capability — a viewer creates/deploys/configures a canvas from the page"
type: feat
date: 2026-07-04
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
origin: docs/plans/2026-07-04-001-feat-canvas-authoring-capability-design.md
product_contract_source: ce-brainstorm
depth: deep
---

# feat: Canvas authoring capability

**Origin:** [design spec](2026-07-04-001-feat-canvas-authoring-capability-design.md) (brainstorm output). Product Contract carried forward unchanged; the four open questions are resolved below.

**Product Contract preservation:** unchanged. The design spec's goals/non-goals/error-codes/tests are honored verbatim; this plan only adds the HOW.

---

## Summary

Add a new backend capability, **`authoring`**, that lets a backend-enabled canvas offer its *signed-in members* a way to create → deploy → configure a new canvas **as themselves**, from the page — no service secret, nothing stored in the consuming canvas's repo. It is shaped **identically to the AI primitive**: a Backend-tab toggle (off by default), an operator instance switch + quota (DB-overrides-env, resolved per request), a `/v1/c/:slug` route behind `requireCapability("authoring")`, and one SDK namespace `canvasdrop.canvases.{publish,list,revoke}`. The route reuses the existing management services (`canvases.create`, the deploy engine, the sharing/update path) under the **viewer's principal**, rejects guest/public-link viewers, and meters against a dedicated `authoring_usage` table.

Downstream, this unblocks a separate product-roadmap consumer (a "Share this view" snapshot feature) — **not built here**.

---

## Problem Frame

Canvas creation is authorized today only by a signed-in **user** principal through the foundation gateway (`routes/management.ts` → `canvases.create({ actorId: user.id, … })`). The two machine paths — a per-canvas deploy key and the connect-once MCP — can deploy to an *existing* canvas or act as the interactive user, but a canvas's own frontend has no way to mint a *new* canvas from the page (see origin: Problem).

**Key insight (origin):** the viewer is *already authenticated*. A backend-enabled canvas serves its page to a gateway-authenticated member and already exposes that identity via `canvasdrop.me()`. Their create-capable principal is present in the request, so no stored service secret is needed — a new capability can create canvas B **as the signed-in viewer**, with real per-user ownership, gated by the operator exactly like AI.

---

## Resolved Open Questions

| # | Question | Resolution |
|---|----------|-----------|
| 1 | Capability + SDK naming | Capability **`authoring`**; SDK **`canvasdrop.canvases.*`** (origin lean, confirmed). |
| 2 | Quota model | Authored canvas counts against **both** the viewer's normal ownership (automatic — it *is* a normal owned canvas) **and** the new authoring quota. |
| 3 | Deploy-failure cleanup | **Return B's id** in `PUBLISH_FAILED`; do not auto-revoke (leave for retry/`revoke`). |
| 4 | Bundle transport | **Direct zip** in the `publish` body, size-limited. Staged content-addressed upload deferred. |
| A | `cap_authoring` column default | **FALSE** (diverges from sibling `cap_*` defaults of `true`) — authoring is higher-privilege, and the spec says "off by default". |
| B | Quota persistence | **Dedicated `authoring_usage` table** (mirrors `ai_usage`), so per-viewer-daily and all-time-total counts survive audit pruning. |

---

## Key Technical Decisions

**KTD1 — Extend the one capability taxonomy, don't fork it.** `packages/shared/src/capabilities/index.ts` is the single source the server guard, the management projection, and the dashboard all route through. Add `authoring` to `FEATURE_CAPABILITIES`, `CanvasCapabilityState` (`capAuthoring`), `FEATURE_COLUMN`, `storedCapabilities`, `effectiveCapabilities` (`backend && capAuthoring && globals.authoringEnabled`), and `CapabilityGlobals` (`authoringEnabled`). The read-side projection (`storedCapabilities`) is dynamic, so management/MCP *reads* pick it up free; the *write* schemas enumerate features explicitly and each need one line (KTD5).

**KTD2 — `cap_authoring` defaults FALSE; a distinct operator instance switch defaulting OFF.** Unlike `cap_kv/files/ai/realtime` (default `true`, gated only by `backendEnabled`), `cap_authoring` defaults `false`: enabling backend does not silently grant page-driven canvas creation. The operator global `config.authoring.enabled` (env `CANVAS_DROP_AUTHORING`, default `"off"`) is the instance master switch, mirroring realtime's `CANVAS_DROP_REALTIME` shape but opt-in. `effectiveCapabilities.authoring = backend && capAuthoring && authoringEnabled`.

**KTD3 — Viewer principal, reject guest/public.** The route resolves `c.get("user")` (gateway-set member identity) and creates with `actorId: viewer.id`. A guest (`c.get("principal")?.kind === "guest"`) or an anonymous/public-link visitor is rejected `NOT_AUTHENTICATED` — creation needs a real member, and public links are static-only (they never reach the runtime API anyway; this is a defense-in-depth explicit check). This is a §12.0-adjacent invariant: identity comes from the server context, never the client.

**KTD4 — Dedicated `authoring_usage` table + `checkAuthoringQuota` mirror.** A new table `authoring_usage { id, actorId, sourceCanvasId, authoredCanvasId, createdAt }` with a repo (`record`, `countByActorSince`, `countByActor` total, `pruneBefore`) mirroring `ai-usage.ts`. A pure `checkAuthoringQuota(dailyCount, totalCount, { dailyMax, totalMax })` mirrors `checkQuota` (reject when prior count `>=` limit; documented TOCTOU, trusted-org model). Windows: **per-viewer-daily** (`dayStartUtc`, reuse `ai/quota.ts` helpers) + **per-viewer all-time total**.

**KTD5 — Agent-native parity: the toggle is settable over MCP.** Per the repo parity rule, `authoring` must be flippable via `set_capabilities`/`update_canvas` (MCP), not just the Backend tab. Add the field to the MCP tool input + echo projection (`mcp/tool-kit.ts`, `mcp/server.ts`), the management `capabilitiesSchema` (`routes/management.ts`), and the dashboard `FEATURES` array (`routes/canvas.capabilities.tsx`) — the same three write-surfaces every existing feature touches. All wrap the same `canvases.setCapabilities` service; no parallel path.

**KTD6 — Route base `/authoring`, SDK namespace `canvasdrop.canvases`.** Mount at `/v1/c/:slug/authoring` (matches the capability name in logs/hints) with `POST /` (publish), `GET /` (list), `DELETE /:id` (revoke). The SDK maps `canvasdrop.canvases.{publish,list,revoke}` onto those endpoints. The name mismatch is intentional: the *capability* is authoring; the *thing produced* is a canvas.

**KTD7 — `publish` is atomic from the caller's view, best-effort server-side.** The route sequences create → deploy → configure and returns one `{ id, url }`. On deploy failure after create, B exists empty; return `PUBLISH_FAILED` carrying `id` (per Q3). Configure (access/tags/expiry/password) applies after a successful deploy; a configure failure is also `PUBLISH_FAILED` with the id (canvas exists, share settings partial — caller can `revoke` or re-`publish`).

**KTD8 — Expiry via the existing `sharedExpiresAt` share-expiry mechanism.** `expiresAt` maps to `sharedExpiresAt` (governs the *share*, meaningful only with a shareable rung). The operator config carries an allowed-rung set + max/required expiry; validation enforces both before any row is created.

---

## High-Level Technical Design

Publish sequence (the one non-obvious flow — the create/deploy/configure pipeline with the deploy-failure branch):

```mermaid
sequenceDiagram
    participant P as Canvas A page (SDK)
    participant R as /v1/c/:slug/authoring
    participant G as requireCapability + isolation
    participant Q as authoring_usage
    participant S as canvases.create / deploy / sharing
    participant Au as audit log

    P->>R: POST { title, slug?, tags?, access?, password?, expiresAt?, bundle }
    R->>G: requireCanvas + requireCapability("authoring")
    G-->>R: 403 CAPABILITY_DISABLED (backend off / cap off / operator off)
    R->>R: viewer = c.get("user"); reject guest/anon → 401 NOT_AUTHENTICATED
    R->>R: zod validate (bundle size, rung ∈ allowed, expiry require/max) → 400 INVALID_BODY
    R->>Q: countByActorSince(day) + countByActor(total)
    Q-->>R: over limit → 429 QUOTA_EXCEEDED { scope }
    R->>S: canvases.create({ actorId: viewer.id, title, slug })
    S-->>R: canvas B (or slug-taken → 409 before any row)
    R->>S: engine.deploy(B, "authoring", bundle, viewer.id)
    S-->>R: deploy fail → 502 PUBLISH_FAILED { id: B.id }
    R->>S: apply access / tags / sharedExpiresAt / password
    R->>Q: record({ actorId, sourceCanvasId: A, authoredCanvasId: B })
    R->>Au: recordAudit({ action: "canvas_authored", actorId, targetId: B, meta:{ sourceCanvasId: A } })
    R-->>P: 200 { id, url }
```

*Directional — the prose in each unit is authoritative where they differ.*

---

## Output Structure

New files (existing files modified in-place, not shown):

```
apps/server/src/
  routes/canvas-authoring.ts          # the route (mirror of canvas-ai.ts)
  routes/canvas-authoring.test.ts      # route tests (mirror of canvas-ai.test.ts)
  authoring/quota.ts                    # checkAuthoringQuota (mirror of ai/quota.ts)
  authoring/quota.test.ts
  db/repositories/authoring-usage.ts    # usage repo (mirror of ai-usage.ts)
  db/repositories/authoring-usage.test.ts
drizzle/pg/NNNN_<slug>.sql              # cap_authoring + authoring_usage (pg)
drizzle/sqlite/NNNN_<slug>.sql          # cap_authoring + authoring_usage (sqlite)
```

---

## Implementation Units

### U1. Extend the capability taxonomy + operator globals (shared)

**Goal:** `authoring` becomes a first-class feature capability in the single-source taxonomy and config, with its operator instance switch.
**Requirements:** origin "Design", Q1/QA; KTD1, KTD2.
**Dependencies:** none.
**Files:** `packages/shared/src/capabilities/index.ts`, `packages/shared/src/capabilities/index.test.ts`, `packages/shared/src/config/env.ts`, `packages/shared/src/config/env.test.ts`, `apps/server/src/canvas/capability-guard.ts`, `.env.example`.
**Approach:**
- Add `authoring` to `FEATURE_CAPABILITIES`; add `capAuthoring: boolean` to `CanvasCapabilityState`; extend `FEATURE_COLUMN` (`authoring → "capAuthoring"`), `storedCapabilities`, and `effectiveCapabilities` (`authoring: backend && canvas.capAuthoring && globals.authoringEnabled`). Add `authoringEnabled: boolean` to `CapabilityGlobals`.
- `config/env.ts`: add `CANVAS_DROP_AUTHORING: z.enum(["on","off"]).default("off")` → `config.authoring.enabled`; plus quota/policy defaults: `CANVAS_DROP_AUTHORING_USER_DAILY_MAX` (num, e.g. 20), `CANVAS_DROP_AUTHORING_USER_TOTAL_MAX` (num, e.g. 200), `CANVAS_DROP_AUTHORING_ALLOWED_RUNGS` (csv of access rungs, default all shareable), `CANVAS_DROP_AUTHORING_MAX_EXPIRY_DAYS` (num, 0 = no max), `CANVAS_DROP_AUTHORING_REQUIRE_EXPIRY` (bool, default false). Validate at boot like the AI block.
- `capability-guard.ts`: extend `capabilityGlobals(config)` with `authoringEnabled: config.authoring.enabled`; add an `authoring` branch to `capabilityDisabledDetail` operator-disabled hint; add `authoringEnabled?: () => Promise<boolean>` to `CapabilityGlobalOverrides` and resolve it per request in `requireCapability`.
**Patterns to follow:** the `realtime`/`ai` handling in the same functions; `config.ai.*` block in `env.ts`.
**Test scenarios:**
- `effectiveCapabilities`: `authoring` is `true` only when `backend && capAuthoring && authoringEnabled`; `false` if any is off. Covers the 3 gates.
- Backwards default: a canvas literal without `capAuthoring` set behaves as the column default (false) once the type requires it — update existing capability fixtures to include `capAuthoring`.
- `env`: `CANVAS_DROP_AUTHORING` unset → `enabled=false`; `"on"` → true; invalid → boot error. Quota defaults parse; `ALLOWED_RUNGS` csv parses.
- `capabilityDisabledDetail`: `authoring` + `operator_disabled` yields the authoring-specific hint.

### U2. Schema + migrations: `cap_authoring` column + `authoring_usage` table (both dialects)

**Goal:** persistence for the per-canvas toggle and the usage counter, additive on both dialects.
**Requirements:** QA, QB; KTD2, KTD4.
**Dependencies:** U1 (the shared types the schema is inferred against).
**Files:** `packages/shared/src/db/schema.pg.ts`, `packages/shared/src/db/schema.sqlite.ts`, `drizzle/pg/*`, `drizzle/sqlite/*`, the schema-parity test (wherever it asserts column/table parity).
**Approach:**
- Add `capAuthoring: c.bool("cap_authoring").notNull().default(false)` to the `canvases` table in **both** schema files (note: default `false`, unlike the sibling `cap_*` defaults of `true`).
- Add an `authoringUsage` table `{ id (uuidv7 pk), actorId (fk users), sourceCanvasId (fk canvases), authoredCanvasId (fk canvases), createdAt }` in both files, with indexes `(actor_id, created_at)` and `(source_canvas_id, created_at)` — mirroring `ai_usage`'s two indexes.
- Generate migrations for **both** dialects (`drizzle-kit generate` for pg and sqlite configs) and commit them. Additive only; the `cap_authoring` default backfills existing rows to `false`.
**Patterns to follow:** the `aiUsage` table + `cap_*` columns; the CLAUDE.md dual-dialect migration workflow.
**Test scenarios:**
- Schema-parity test stays green on both dialects (new column + new table present in both).
- Migration idempotency test (existing "applies migrations cleanly and is idempotent") passes on a fresh DB, both legs.
- A pre-existing canvas row reads `capAuthoring === false` after migration.

### U3. Operator config surface (admin settings + config-fields)

**Goal:** the instance switch, quota, allowed rungs, and expiry policy are admin-visible/tunable (DB overrides env), resolved per request.
**Requirements:** origin "Operator config + quota"; KTD2, KTD4, KTD8.
**Dependencies:** U1.
**Files:** `apps/server/src/admin/config-fields.ts`, `apps/server/src/admin/settings-service.ts`, `apps/server/src/admin/settings-service.test.ts`.
**Approach:**
- `config-fields.ts`: add descriptors `authoring.enabled` (bool, `fromConfig: c => c.authoring.enabled`, mirror `realtime.enabled` at ~line 172), and quota descriptors `quota.authoring.user.daily.max`, `quota.authoring.user.total.max`, plus policy fields for allowed rungs / max-expiry-days / require-expiry.
- `settings-service.ts`: add `authoringEnabled(): Promise<boolean>` (mirror `effectiveRealtimeEnabled`), extend `QuotaKey` union + `QUOTA_KEYS` with the two authoring keys, and add `effectiveAuthoringPolicy()` (resolves allowed-rung set + max-expiry + require-expiry, DB override ?? env) for the route.
**Patterns to follow:** `aiEnabled()`, `effectiveRealtimeEnabled()`, `effectiveQuota(key, fallback)`, the `quota.ai.*` descriptors.
**Test scenarios:**
- `authoringEnabled()` returns the DB override when set, else `config.authoring.enabled`.
- `effectiveQuota("quota.authoring.user.daily.max", fallback)` returns override ?? fallback.
- `effectiveAuthoringPolicy()` reflects a DB-set allowed-rung subset and max-expiry.

### U4. `authoring_usage` repository + `checkAuthoringQuota`

**Goal:** count/record authored canvases and a pure quota decision, mirroring the AI usage repo + `checkQuota`.
**Requirements:** Q2, QB; KTD4.
**Dependencies:** U2.
**Files:** `apps/server/src/db/repositories/authoring-usage.ts`, `apps/server/src/db/repositories/authoring-usage.test.ts`, `apps/server/src/authoring/quota.ts`, `apps/server/src/authoring/quota.test.ts`.
**Approach:**
- Repo `authoringUsageRepository(client)`: `record({ actorId, sourceCanvasId, authoredCanvasId })`, `countByActorSince(actorId, sinceMs)`, `countByActor(actorId)` (all-time total), `pruneBefore(cutoffMs)`. Reuse the dual-dialect count pattern from `ai-usage.ts` (`spendSince` shape, `COUNT(*)` instead of `SUM(cost)`).
- `authoring/quota.ts`: `checkAuthoringQuota(dailyCount, totalCount, { dailyMax, totalMax }): { ok:true } | { ok:false, scope: "user_daily" | "user_total" }` — reject when prior count `>=` limit; daily checked first (its scope wins). Reuse `dayStartUtc` from `ai/quota.ts`.
**Patterns to follow:** `apps/server/src/db/repositories/ai-usage.ts`, `apps/server/src/ai/quota.ts` + `quota.test.ts` (boundary tests).
**Test scenarios:**
- `record` then `countByActorSince(actor, dayStart)` returns 1; a second actor's row does not count. Integration (real dual-dialect DB via `makeTestDb`).
- `countByActor` totals across days; `pruneBefore` deletes old rows and returns the deleted count.
- `checkAuthoringQuota`: `daily >= dailyMax` → `{ ok:false, scope:"user_daily" }`; `total >= totalMax` → `user_total`; both under → `ok`; daily wins when both exhausted; boundary at exactly the limit rejects.

### U5. Server route `canvas-authoring.ts` + wiring

**Goal:** the `/v1/c/:slug/authoring` route: publish/list/revoke under the viewer principal, gated, quota'd, validated, metered, audited.
**Requirements:** origin "Server route" + "Error handling" + "Testing"; Q3, KTD3, KTD6, KTD7, KTD8.
**Dependencies:** U1, U2, U3, U4.
**Files:** `apps/server/src/routes/canvas-authoring.ts`, `apps/server/src/routes/canvas-authoring.test.ts`, `apps/server/src/routes/canvas-api.ts` (mount), `apps/server/src/app.ts` (wire the `authoringUsage` repo + deps), `apps/server/src/wiring.ts` if the repo is shared.
**Approach:**
- `canvasAuthoringRoutes(deps)` returns a Hono app; `app.use("*", requireCapability("authoring", config, { authoringEnabled: () => settings.authoringEnabled() }))`.
- `POST /` (`publish`): `bodyLimit` at the deploy bundle max; parse multipart or raw-zip body (bundle) + JSON metadata (title, slug?, tags?, access?, password?, expiresAt?). `requireCanvas(c)` = source canvas A. `viewer = c.get("user")`; if `c.get("principal")?.kind === "guest"` or no `viewer` → `401 NOT_AUTHENTICATED`. Validate (zod): bundle size ≤ deploy limit → else `INVALID_BODY`; `access` ∈ `effectiveAuthoringPolicy().allowedRungs` → else `INVALID_BODY`; expiry present-if-required and ≤ max → else `INVALID_BODY`. Quota: `countByActorSince(viewer.id, dayStartUtc(now))` + `countByActor(viewer.id)` → `checkAuthoringQuota` → `429 QUOTA_EXCEEDED { scope }`. Execute: `canvases.create({ actorId: viewer.id, title, slug })` (slug-taken throws before any row → `409`); `engine.deploy(B, "authoring", bundleStream, viewer.id)` — on failure `502 PUBLISH_FAILED { id: B.id }`; apply `access`/`tags`/`sharedExpiresAt`/`password` via the existing sharing/update service — on failure `502 PUBLISH_FAILED { id: B.id }`. `authoringUsage.record(...)`; `audit.recordAudit({ action:"canvas_authored", actorId: viewer.id, targetId: B.id, meta:{ sourceCanvasId: A.id } })`. Return `200 { id: B.id, url: canvasUrl(config, B.slug) }`.
- `GET /` (`list`): canvases owned by `viewer.id` that were authored (join/filter via `authoring_usage.actorId = viewer.id`), projected to `{ id, url, title, tags, expiresAt }`.
- `DELETE /:id` (`revoke`): resolve B; authorize `B.ownerId === viewer.id` **or** admin, else `404` (no-leak, §12.0); delete/unpublish via the existing management delete path; audit.
- Mount in `canvas-api.ts`: `app.route("/authoring", canvasAuthoringRoutes({ config, canvases, engine, storage, authoringUsage, audit, settings }))`, next to `/ai`. Add `authoringUsage` to `app.ts`/`wiring.ts` composition.
**Patterns to follow:** `routes/canvas-ai.ts` (guard/quota/validate/execute shape, `requireCanvas`, guest check, `c.json({ code }, status)` envelope), `routes/management.ts` create + sharing/update handlers, `deploy/engine.ts` `deploy()` signature, `canvas/url.ts`.
**Execution note:** start with a failing route test for the capability-off and guest-viewer paths (the invariant-critical gates) before the happy path.
**Test scenarios:** (mirror `canvas-ai.test.ts`, fake services injected)
- Covers origin AE: capability off (backend off OR `cap_authoring` off OR operator switch off) → `403 CAPABILITY_DISABLED`.
- Covers origin AE: guest viewer (`principal.kind === "guest"`) and anonymous → `401 NOT_AUTHENTICATED`; no canvas is created.
- Covers origin AE: quota exceeded (daily or total) → `429 QUOTA_EXCEEDED` with the right `scope`; no create.
- Covers origin AE: disallowed access rung → `400 INVALID_BODY`; over-max / missing-required expiry → `400 INVALID_BODY`; oversized bundle → `413`/`INVALID_BODY`.
- Covers origin AE: happy path → `canvases.create` called with `actorId === viewer.id`, deploy invoked with the bundle, access/expiry/tags/password applied, `authoring_usage` row recorded, `canvas_authored` audit written, returns `{ id, url }`.
- Deploy failure after create → `502 PUBLISH_FAILED` carrying `id`; the empty canvas is NOT auto-deleted; no usage row recorded (or recorded — assert the chosen semantics: record only on full success).
- `revoke`: viewer can revoke their own authored canvas; another user's id → `404`; admin can revoke any.
- `list`: returns only the viewer's authored canvases, projected shape, excludes canvases authored by others.
- Isolation: a `publish` request whose `Origin` mismatches the path slug is rejected by `canvasApiIsolation` (inherited) — assert the mount sits behind it.

### U6. SDK surface `canvasdrop.canvases.*`

**Goal:** the browser SDK exposes `publish`/`list`/`revoke`, viewer-scoped, with typed errors.
**Requirements:** origin "SDK surface"; Q1, Q4, KTD6.
**Dependencies:** U5 (endpoint contract).
**Files:** `packages/sdk/src/index.ts`, `packages/sdk/src/*.test.ts` (the SDK test file), `apps/server/src/docs/generated-content.ts` / docs if the SDK reference is generated.
**Approach:**
- Add `CanvasesNamespace` to `CanvasdropClient`: `publish(opts): Promise<{ id; url }>`, `list(): Promise<Array<{ id; url; title; tags; expiresAt }>>`, `revoke(id): Promise<void>`.
- `publish` POSTs the bundle (`Blob | ArrayBuffer`) + metadata to `/v1/c/:slug/authoring` (derive base + slug from `detectContext`, same as other namespaces). Map non-2xx via the existing `errorFromResponse` (`NotAuthenticatedError`, `QuotaExceededError`, `CapabilityDisabledError`); add a `PUBLISH_FAILED` typed error carrying `id`, and surface `INVALID_BODY`.
- Add `PUBLISH_FAILED` to `ERROR_CODES` and a `PublishFailedError extends CanvasdropError` exposing `.id`.
**Patterns to follow:** the `ai`/`files` namespaces + `errorFromResponse` + `ERROR_CODES` in `packages/sdk/src/index.ts`.
**Test scenarios:**
- `publish` posts to the right URL with bundle + metadata; resolves `{ id, url }` on 200.
- 401 → `NotAuthenticatedError`; 429 → `QuotaExceededError`; 403 → `CapabilityDisabledError`; 502 `PUBLISH_FAILED` → `PublishFailedError` with `.id` set.
- `list` returns the parsed array; `revoke(id)` DELETEs and resolves void; a 404 on revoke → `NotFoundError`.

### U7. MCP + management parity for the toggle (agent-native rule)

**Goal:** an agent (and the management API) can set `authoring` exactly like `ai`/`realtime`.
**Requirements:** repo parity rule (CLAUDE.md); KTD5.
**Dependencies:** U1, U2.
**Files:** `apps/server/src/mcp/tool-kit.ts`, `apps/server/src/mcp/server.ts`, `apps/server/src/routes/management.ts`, `apps/server/src/mcp/*.test.ts`, `apps/server/src/routes/management.test.ts`.
**Approach:**
- Add `authoring?: boolean` to the `capabilitiesSchema` (`routes/management.ts` ~line 128) and thread it into the `setCapabilities` call.
- Add `authoring` to the MCP `set_capabilities`/`update_canvas` input schema + the echoed projection (`tool-kit.ts` ~line 54/91, `server.ts`). All wrap the same `canvases.setCapabilities` service.
**Patterns to follow:** the existing `backendEnabled`/`capAi`/`capRealtime` fields in the same schemas/projections.
**Test scenarios:**
- Management `PATCH /api/canvases/:id/capabilities { authoring: true }` sets `cap_authoring`; the projection echoes it.
- MCP `set_capabilities` with `authoring: true` on an owned canvas persists it; on a non-owned id → not-found (owner check).
- `update_canvas`/`get_canvas` projection includes `authoring` in stored capabilities.

### U8. Dashboard Backend tab toggle

**Goal:** the owner sees and flips `authoring` on the Backend tab, with the operator-disabled label when the instance switch is off.
**Requirements:** origin "Design" (Backend-tab toggle); KTD2, KTD5.
**Dependencies:** U1, U2, U3, U7.
**Files:** `apps/dashboard/src/routes/canvas.capabilities.tsx`, related dashboard test if present.
**Approach:**
- Add an `authoring` entry to the `FEATURES` array (`{ key: "authoring", label: "Authoring", description: … }`), mirroring the `ai`/`realtime` entries. Wire the operator-global gate so when `authoringEnabled` is false the toggle shows "Disabled by your administrator" (mirror how AI shows it when no key is configured), reading the effective flag exposed by `/api/me` or the capabilities endpoint.
**Patterns to follow:** the `ai`/`realtime` `FEATURES` entries and their operator-disabled treatment in the same file.
**Test scenarios:** `Test expectation: none — presentational toggle`; if the file has existing capability tests, extend them to assert the `authoring` row renders and disables while backend is off / operator switch off. Otherwise covered by U7's API tests + manual verification.

### U9. Documentation refresh (code-as-truth)

**Goal:** every doc surface reflects the new `authoring` capability, matching the shipped code.
**Requirements:** repo docs convention; the capability is not "done" until documented (parity with how AI/realtime are documented).
**Dependencies:** U1–U8 (document the shipped surface, not the plan).
**Files:** `apps/server/src/docs/generated-content.ts` (llms.txt + search index), the served docs pages under `docs/site/**` (SDK reference, capabilities/primitives, self-hosting/config), `.env.example` (the new `CANVAS_DROP_AUTHORING*` vars — also touched in U1), `README.md` Status, and — if surfacing to marketing — the primitives/capabilities copy in `apps/server/src/http/landing-page.ts`.
**Approach:**
- Prefer the repo's **docs-refresh** skill (code-as-truth: extract code facts → rewrite the descriptive docs → adversarially verify each claim against source). Run it after U1–U8 land so it documents the real surface.
- Cover: the `canvasdrop.canvases.{publish,list,revoke}` SDK reference (signatures, error codes incl. `PUBLISH_FAILED`/`NOT_AUTHENTICATED`/`QUOTA_EXCEEDED`/`INVALID_BODY`/`CAPABILITY_DISABLED`); the Backend-tab `authoring` capability + that it is off by default and operator-gated; the new operator env vars + quota/policy knobs; the `set_capabilities` MCP field. Decide (and note) whether to add authoring to the landing's marketing copy — it is a capability, not one of the "five primitives", so surfacing there is optional.
**Patterns to follow:** how `ai`/`realtime` are documented across the same surfaces; the `docs-refresh` skill's verify-against-source loop.
**Test scenarios:** `Test expectation: none — documentation`. Verification is the docs-refresh adversarial pass (every claim traced to source) + `pnpm build` still succeeds (generated-content compiles).

---

## Verification Contract

- `pnpm lint && pnpm typecheck && pnpm test` green on **both** dialects (the schema/migration units make this non-negotiable — the parity test + real-migration test must pass on sqlite and pglite).
- Route tests (U5) mirror `canvas-ai.test.ts` and cover every origin acceptance example (capability-off, guest, quota, invalid body, happy path, revoke scoping).
- Manual smoke on a dev instance: enable backend + authoring on a canvas, `CANVAS_DROP_AUTHORING=on`, call `canvasdrop.canvases.publish` from a page as a signed-in member → canvas B appears in that member's dashboard with the chosen access/tags/expiry; `revoke` removes it; a guest call returns `NOT_AUTHENTICATED`.
- MCP: `set_capabilities { authoring: true }` toggles the flag (parity check).

## Definition of Done

All nine units landed (incl. the U9 docs refresh); both-dialect CI green on the PR; migrations committed for pg + sqlite; the capability is settable via Backend tab **and** `set_capabilities`; SDK `canvasdrop.canvases.*` published with typed errors; docs surfaces (served docs, llms.txt, SDK reference, env/self-hosting, README Status) reflect the shipped capability; `/ce-code-review` run on the branch with real findings fixed (weight §12.0 gates — the guest/viewer/ownership checks — as P0). PR opened, **no direct commits to `main`** (branch protection); autonomous merge only after the full suite is green per the repo's autonomous-round contract.

---

## Scope Boundaries

**In scope:** the `authoring` capability end-to-end (taxonomy, schema/migrations, operator config/quota, route, SDK, MCP parity, Backend-tab toggle) + tests.

### Deferred to Follow-Up Work
- Staged content-addressed upload for `publish` (Q4) — adopt if re-publish bundle size becomes a problem; the deploy API already supports it.
- Auto-revoke on deploy failure (Q3) — revisit if empty-canvas litter becomes real.
- Per-source-canvas monthly quota window — the table + repo support it (`sourceCanvasId` index); add a third `checkAuthoringQuota` window if a runaway consumer needs bounding.

### Outside this product's identity (origin non-goals)
- The roadmap "Share this view" consumer (separate spec; depends on this).
- Service-account / shared-credential minting.
- Canvas creation via a per-canvas deploy key (keys stay deploy-only).
- Arbitrary server compute / running a site build inside a canvas backend.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|-----------|
| **Privilege escalation** — a page mints canvases as the viewer beyond intent. | `cap_authoring` defaults FALSE + operator instance switch defaults OFF (double opt-in); reject guest/public; quota caps per-viewer daily + total; every op audited with `sourceCanvasId`. |
| **Dual-dialect migration drift** (Risk #2). | New column + table added to both schema files in lockstep; migrations generated for both; parity + real-migration tests gate CI. |
| **Deploy-failure litter** — empty canvas B on partial publish. | Documented `PUBLISH_FAILED { id }`; `revoke` + re-`publish` are the recovery; record usage only on full success so a failed publish doesn't burn quota. |
| **Bundle-size DoS** via the direct-zip body. | `bodyLimit` at the existing deploy bundle max; validated before create. |
| **Parity gap** — toggle settable in UI but not MCP. | U7 makes MCP/management/dashboard the same three write-surfaces; a parity test asserts `set_capabilities` flips it. |

## Sources & Research

- Origin: `docs/plans/2026-07-04-001-feat-canvas-authoring-capability-design.md`.
- Patterns mirrored (read during planning): `apps/server/src/routes/canvas-ai.ts`, `apps/server/src/canvas/capability-guard.ts`, `apps/server/src/ai/quota.ts`, `apps/server/src/db/repositories/ai-usage.ts`, `packages/shared/src/capabilities/index.ts`, `apps/server/src/routes/canvas-api.ts`, `apps/server/src/admin/config-fields.ts` + `settings-service.ts`, `packages/shared/src/config/env.ts`, `packages/shared/src/db/schema.pg.ts`, `apps/server/src/routes/management.ts`, `apps/server/src/mcp/tool-kit.ts`, `apps/dashboard/src/routes/canvas.capabilities.tsx`.
- Institutional learnings to read before implementing: `docs/solutions/2026-06-13-canvas-capability-model.md` (the effective = backend AND flag AND operator-global rule + KTDs), `docs/solutions/2026-06-13-canvas-primitives-runtime-api.md` (the `/v1/c/:slug` pipeline + dual-dialect metering), `docs/solutions/2026-06-13-auth-invariant-checklist.md` (§12.0 gates — read before the viewer/guest/ownership checks), `docs/solutions/2026-06-13-dual-dialect-drizzle-seam.md` (schema/migration parity).
