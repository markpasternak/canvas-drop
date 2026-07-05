---
title: "Managed Canvas Shares (authoring v2) - Plan"
type: feat
date: 2026-07-05
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-brainstorm
---

# Managed Canvas Shares (authoring v2) - Plan

**Product Contract preservation:** unchanged. The brainstorm's requirements/actors/flows/acceptance-examples are honored verbatim; this plan adds only the HOW. Builds on the shipped v1 authoring capability (`docs/plans/2026-07-04-002-feat-canvas-authoring-capability-plan.md`).

## Goal Capsule

**Objective.** Upgrade `canvasdrop.canvases.*` from fire-and-forget publishes into **managed shares** — durable, updatable, listable artifacts — so a downstream product-roadmap app can create a share once, update it in place (same URL), and render a management "Share tab".

**Product authority.** Requirements confirmed with the repo owner in this session's brainstorm. Three scope forks locked: management stays **owner-or-admin**; **update deploys a new immutable version** to the same canvas (stable URL, reuse the version model); **revoke keeps the record listed** as `revoked`.

**Open blockers.** None — the four technical questions are resolved in Key Technical Decisions below.

**Build boundary.** SDK + server/API in **this** repo. The product-roadmap consumer app is a separate repo — design for it, don't build it.

---

## Problem Frame

v1 authoring mints a **new** canvas per `publish()`. The roadmap app needs to create a share once and **re-publish into it** at a stable URL, plus a management view (status, access, expiry, last-updated) with open/copy/update/revoke actions. Today the app can only mint another canvas (no `update`), can't read a share's lifecycle state, and `revoke()` makes the record vanish from `list()`. See the Product Contract below (carried from the brainstorm) for the full requirement set.

---

## Product Contract

*(Carried verbatim from the brainstorm — the WHAT. Unchanged by planning.)*

### Actors

- **A1 — Share creator** (a signed-in member; the roadmap app acts *as* this member). Creates/updates/lists/revokes their own shares.
- **A2 — Admin.** May update/revoke any share (existing cross-owner admin power).
- **A3 — Public reader.** Reads shared static content only — never author/management metadata.
- **A4 — Operator.** Owns the instance authoring switch + quota/policy (unchanged from v1).

### Requirements

**R1 — Durable share.** `publish(options)` creates a canvas/share with stable `id`/`url`, returning the richer `AuthoredCanvas` (R4). Backward compatible.

**R2 — Update in place.** `update(id, options)` replaces bundle/content and/or settings **without changing the public URL** — an updated bundle deploys as a **new immutable version** of the same canvas (stable slug, history + rollback preserved). May change `title`/`tags`/`access`/`password`/`expiresAt`/`metadata`/`bundle`. Omitted fields unchanged; `password: null` / `expiresAt: null` explicitly clear. Returns the updated `AuthoredCanvas`.

**R3 — Structured metadata.** `publish`/`update` accept `metadata: Record<string, unknown>` (bounded), beyond `tags` — `sourceApp`, `sourceKind`, `theme`, `itemCount`, `filters`, `generatedAt`, etc. Round-tripped on `list()`. `sourceApp`/`sourceKind` are filterable (R5).

**R4 — Management-grade `list()`.** Returns each share with `id`, `url`, `title`, `tags`, `access`, `status`, `createdAt`, `updatedAt`, `expiresAt`, `revokedAt`, `createdBy`, `bundleUpdatedAt`/`version`, `sourceApp`, `sourceKind`, `metadata`. **`status`** derived, precedence **`revoked` › `expired` › `private` › `live`**. `list()` now **includes** revoked/expired shares (change from v1).

**R5 — Filtered listing.** `list(filter?: { sourceApp?, sourceKind?, tags? })` returns the matching subset.

**R6 — Revoke keeps the record.** `revoke(id)` makes the public URL unavailable and stamps `revokedAt` + `status: revoked`, but the record **stays in `list()`**. Signature unchanged.

**R7 — Access rungs preserved.** `private`/`specific_people`/`public_link`/`password` on publish and update; `password` → password-protected public link. Operator gates (public-link switch, per-account grant, allowed-rung + expiry policy) apply to `update` as to `publish`.

**R8 — Management authz (owner + admin).** Only creator or admin may `update`/`revoke`; a non-owned id reads as **not-found** (§12.0 no leak). `list()` is creator-scoped. *(Team-member management deferred — Scope Boundaries.)*

**R9 — Reader isolation.** Public/permitted readers get only shared static content; author/management metadata is served **only** on the authenticated management API, never on the public canvas-serve path. Revoked/expired shares are not publicly readable.

**R10 — Backward compatibility.** `publish`/`list`/`revoke` keep working (same signatures). The two observable changes are additive-or-intended: extra return fields, and `list()` now includes revoked/expired with a `status`.

**R11 — Errors.** Stable `message`/`code` + optional `hint` (the `CanvasdropError` contract).

**R12 — SDK types.** See the brainstorm's `PublishOptions`/`UpdateOptions`/`AuthoredCanvas`/`Canvasdrop` shapes — implemented superset-compatible with v1.

### Key Flows

- **F1 — Create → update × N (stable URL).** `publish` → `{id, url}`; `update(id, {bundle, metadata})` repeatedly → same `url`, new version each time.
- **F2 — Share tab.** `list({ sourceApp: "product-roadmap" })` → a table with status/access/expiry/updatedAt + actions.
- **F3 — Revoke → still managed.** `revoke(id)` → URL 404s, record stays as `status: revoked`.
- **F4 — Change access/expiry.** `update(id, { access, password, expiresAt })` → same canvas flips rung, URL unchanged.

### Acceptance Examples

- **AE1.** Publish then `update` ×3 with new bundles → identical `url`; live page reflects the latest each time.
- **AE2.** `list({ sourceApp })` returns only matching shares with status/access/expiresAt/updatedAt populated.
- **AE3.** After `revoke(id)`, the public URL is not readable, but `list()` returns it with `status: "revoked"` + non-null `revokedAt`.
- **AE4.** A share past `expiresAt` shows `status: "expired"` and is not publicly readable.
- **AE5.** A non-creator, non-admin calling `update`/`revoke` on someone else's share gets a not-found error (no leak).
- **AE6.** A public reader of a live share receives content but no `metadata`/`createdBy`/`sourceApp`/status.
- **AE7.** A v1 caller doing `publish`/`list`/`revoke` still works; `list()` now also surfaces its revoked items with a `status`.

---

## Key Technical Decisions

**KTD1 — Metadata: one nullable `metadata` JSON column on `canvases`; filter in-memory.** The share *is* a canvas, so metadata lives on the canvas row (updated on each `update`). `sourceApp`/`sourceKind` live inside that JSON, not as extracted columns — the `list()` filter runs **in-memory** over the viewer's already-bounded authored set (≤ `userTotalMax`, default 200; trusted-org scale), avoiding the dual-dialect JSON-query trap (`docs/solutions/2026-06-13-gallery-listing-patterns.md`: the pg `@>`/sqlite json-membership divergence). A DB-side filter with extracted indexed columns is a deferred optimization if the set ever grows large.

**KTD2 — Update reuses the version model; **no quota consumed**.** `update(id, {bundle})` calls `engine.deploy` on the existing canvas — a new immutable version, stable slug/URL, history + one-click rollback for free (exactly how every other deploy path works). `update` is an *edit*, not a create, so it does **not** run `checkAuthoringQuota` or record `authoring_usage` (only `publish` does). `bundleUpdatedAt`/`version` in the projection read the canvas's current version.

**KTD3 — Revoke: a nullable `revoked_at` column + unpublish.** `revoke(id)` sets `revoked_at = now` **and** unpublishes the canvas (clears `currentVersionId`, so the content chain has nothing to serve → the URL 404s). The row stays `status: "active"` (so it is **not** swept/hidden like a soft-deleted canvas) and thus remains queryable by `list()`. This diverges from v1's `setStatus("deleted")`. A revoked share is terminal: `update()` on a revoked share is rejected (re-sharing = a fresh `publish`, per F3).

**KTD4 — Status is a shared pure helper.** `shareStatus(access, sharedExpiresAt, revokedAt, now) → "live" | "expired" | "revoked" | "private"` lives in `packages/shared` (like `isCapabilityEnabled`/`isAnonymouslyPublic`), so the server projection and the SDK's `AuthoredCanvas` status enum share one source of truth. Precedence: `revoked` (revoked_at set) › `expired` (past sharedExpiresAt) › `private` (access === "private") › `live`.

**KTD5 — Reader isolation is structural, not a filter.** Author/management metadata is only ever assembled in the authoring route's projection (the authenticated management API). The public canvas-serve path (`serveCanvas`, `socialPreview`) never reads the `metadata` column, so a public reader structurally cannot receive it. Unpublish (KTD3) makes revoked shares 404 for readers; expired shares are already denied by `decideCanvasAccess`'s share-expiry check.

**KTD6 — No new MCP/dashboard surface.** A share is a canvas; owners already manage canvases (delete/settings) via the dashboard + MCP (`delete_canvas`, `update_canvas`, `set_canvas_slug`, …). The `update`/`list`/`revoke` *share-management UI* is the consuming app's job (built over the SDK as the viewer). The agent-native parity rule is satisfied — no owner-facing dashboard capability is added here.

**KTD7 — Backward compatibility.** `publish`/`list`/`revoke` keep their signatures; the SDK return type widens from `{id,url}`/the old list shape to `AuthoredCanvas` (added fields — source-compatible). `list()` now includes revoked/expired records (intended). `revoke` no longer removes the record from `list()` (intended). These are the only observable changes; a v1 consumer keeps working.

---

## High-Level Technical Design

The publish/update/revoke lifecycle over one canvas (the share), URL stable throughout:

```mermaid
stateDiagram-v2
    [*] --> Live: publish(bundle, metadata)\n(create + deploy v1 + configure + meter/quota)
    Live --> Live: update(bundle/settings/metadata)\n(deploy vN+1, same URL, NO quota)
    Live --> Expired: sharedExpiresAt passes\n(derived; reader denied)
    Live --> Private: access set to private\n(derived; owner-only)
    Private --> Live: update(access = shareable)
    Live --> Revoked: revoke()\n(set revoked_at + unpublish → URL 404s)
    Expired --> Revoked: revoke()
    Private --> Revoked: revoke()
    Revoked --> [*]: stays in list() as "revoked"\n(update() rejected; re-share = new publish)
```

*Status in `list()` is derived, not stored (KTD4): `revoked` › `expired` › `private` › `live`.*

---

## Implementation Units

### U1. Schema + migration: `revoked_at` + `metadata` columns (both dialects)

**Goal:** persistence for revoke-stays-listed and structured metadata.
**Requirements:** R3, R6; KTD1, KTD3.
**Dependencies:** none.
**Files:** `packages/shared/src/db/schema.pg.ts`, `packages/shared/src/db/schema.sqlite.ts`, `packages/shared/src/db/schema.test.ts`, `drizzle/pg/*`, `drizzle/sqlite/*`.
**Approach:**
- Add to the `canvases` table in **both** dialect files: `revokedAt` (`epochMs`, nullable) and `metadata` (the dialect JSON type — `jsonb`/text-json — nullable). Mirror the existing nullable `sharedExpiresAt` (epochMs) and `tags` (json) columns.
- Generate migrations for **both** dialects (`drizzle-kit generate` pg + sqlite, `--name=managed_shares`); additive (nullable columns backfill NULL). Commit `drizzle/pg/*` + `drizzle/sqlite/*`.
**Patterns to follow:** the v1 `cap_authoring`/`authoring_usage` migration (`docs/plans/2026-07-04-002-…`), `sharedExpiresAt`/`tags` columns, the CLAUDE.md dual-dialect migration workflow.
**Test scenarios:**
- Schema-parity test green on both dialects (new columns present + identical shape).
- Migration idempotency test passes on a fresh DB, both legs.
- A pre-existing canvas reads `revokedAt === null` and `metadata === null` after migration.

### U2. Shared `shareStatus` helper + `AuthoredCanvas` projection

**Goal:** one source of truth for the derived status + the management projection.
**Requirements:** R4, R9; KTD4, KTD5.
**Dependencies:** U1.
**Files:** `packages/shared/src/canvas/share-status.ts` (new), `packages/shared/src/canvas/share-status.test.ts` (new), `packages/shared/src/index.ts` (export), `apps/server/src/routes/canvas-authoring.ts` (projection builder + type).
**Approach:**
- `packages/shared`: pure `shareStatus(access, sharedExpiresAt, revokedAt, now): ShareStatus` with the KTD4 precedence, plus the `ShareStatus` union type. No I/O. (Co-locate with or mirror `isAnonymouslyPublic` in `apps/server/src/canvas/authorization.ts` — but put it in shared so the SDK type aligns.)
- Server: a `toAuthoredCanvas(canvas, config, now)` projection that assembles `{ id, url, title, tags, access, status, createdAt, updatedAt, expiresAt, revokedAt, createdBy, version/bundleUpdatedAt, sourceApp, sourceKind, metadata }` from a canvas row — `createdBy` = the canvas `ownerId` (id only; no PII beyond that), `sourceApp`/`sourceKind` read from the `metadata` blob, `version`/`bundleUpdatedAt` from the current version. This projection is used by publish/update/list.
**Patterns to follow:** `isAnonymouslyPublic` (pure predicate), the v1 authoring list projection, `canvasUrl`.
**Test scenarios:**
- `shareStatus`: revoked_at set → `revoked` (even if also expired/private); past expiry → `expired`; access private (not revoked/expired) → `private`; shareable + active → `live`; precedence when multiple apply (revoked wins over expired wins over private).
- `toAuthoredCanvas`: projects all R4 fields; `sourceApp`/`sourceKind` pulled from metadata; `metadata` null → `{}`; never includes owner PII beyond `createdBy` id.

### U3. Route: `update`, enriched `list` + filter, revoke-stays-listed, publish metadata

**Goal:** the managed-share server surface, reusing the v1 route + services.
**Requirements:** R1–R11; KTD1, KTD2, KTD3, KTD7.
**Dependencies:** U1, U2.
**Files:** `apps/server/src/routes/canvas-authoring.ts`, `apps/server/src/routes/canvas-authoring.test.ts`, `apps/server/src/db/repositories/canvases.ts` (repo methods).
**Approach:**
- **publish (`POST /`)** — accept `metadata` in the body schema; persist it (via `updateSettings` extension or a dedicated write); return the `toAuthoredCanvas` projection (was `{id,url}` — additive). Everything else (create→deploy→configure, quota, gates, review-fix public-link/password/slug handling) unchanged.
- **update (`PUT /:id`)** — resolve canvas B by id; authorize owner-or-admin, non-owned → 404 (mirror the revoke authz). Reject if `revoked_at` is set (SHARE_REVOKED/NOT_FOUND). If `bundle` present → `engine.deploy(B, "api", fromZip, viewer.id)` (new version, stable URL); apply changed settings via the same validated path as publish (rung gates incl. public-link admin gates when access changes, expiry policy, password-before-access ordering, tags, metadata). **No quota check, no `authoring_usage` record.** Return `toAuthoredCanvas`. On deploy/config failure → `PUBLISH_FAILED` (carry id).
- **list (`GET /`)** — build `toAuthoredCanvas` for each of the viewer's authored canvases, now **including** revoked ones (drop the `status !== "deleted"` exclusion for revoked; still exclude truly deleted). Apply the `{ sourceApp, sourceKind, tags }` filter in-memory (KTD1). Read filter from query params.
- **revoke (`DELETE /:id`)** — change from `setStatus("deleted")` to: set `revoked_at = now` + unpublish (clear currentVersionId). Owner-or-admin, non-owned → 404. Record stays listed.
- **Repo:** add `setMetadata`/extend `updateSettings` to write `metadata`; add `revoke`/`setRevokedAt` (set revoked_at) and reuse existing `unpublish`. Extend `CanvasSettingsPatch` with `metadata`.
**Patterns to follow:** v1 `canvas-authoring.ts` (publish pipeline, requireMember, owner-or-admin revoke, the review-fix gates), `management.ts` unpublish/delete, `deploy/engine.ts`.
**Execution note:** start with a failing test for update-in-place (same URL, new version) and the revoke-stays-listed change before the rest.
**Test scenarios:**
- Covers AE1: publish then `update` with a new bundle → same `url`, canvas `currentVersionId` advances, live content is the new bundle.
- Covers AE2/R5: `list({sourceApp})` returns only matching shares; filter by `sourceKind` and `tags` likewise; no filter → all (incl. revoked).
- Covers AE3/R6: `revoke` → `revoked_at` set, `currentVersionId` null (URL unreadable), and `list()` still returns the record with `status: "revoked"`.
- Covers AE5/R8: non-owner update/revoke → 404; owner + admin succeed.
- update does NOT consume quota: after N updates, `authoring_usage.countByActor` is unchanged from the single publish.
- `update` changing access to `public_link` re-runs the public-link admin gates (PUBLIC_NOT_ALLOWED when the account lacks the grant); `password`/`expiresAt` clear via null.
- update on a revoked share → rejected.
- metadata round-trips: publish/update with metadata → `list()` returns it verbatim; `sourceApp`/`sourceKind` surfaced.
- Covers AE7/R10: v1-shape publish/list/revoke calls still succeed.

### U4. SDK: `canvasdrop.canvases.update` + enriched types + list filter

**Goal:** the browser SDK exposes the managed-share surface, backward compatible.
**Requirements:** R1–R6, R11, R12; KTD7.
**Dependencies:** U3 (endpoint contract).
**Files:** `packages/sdk/src/index.ts`, `packages/sdk/src/index.test.ts`.
**Approach:**
- Widen `AuthoredCanvas` to the R4/R12 shape (status, access, timestamps, revokedAt, metadata, sourceApp/sourceKind, createdBy, version/bundleUpdatedAt); import the `ShareStatus` union from shared (or mirror it).
- `PublishOptions.metadata?`, new `UpdateOptions` (all optional, `password`/`expiresAt` nullable), `list(filter?)` param serialized to query string.
- `update(id, options)` → `PUT /v1/c/:slug/authoring/:id` multipart (metadata JSON + optional bundle) → `AuthoredCanvas`; `publish`/`list`/`revoke` return the new shapes; reuse `errorFromResponse` (add any new codes — SHARE_REVOKED).
**Patterns to follow:** the v1 `canvases` namespace, `PublishFailedError`, `errorFromResponse`, the `files.upload` multipart pattern.
**Test scenarios:**
- `update` PUTs multipart to the right URL with metadata (+ optional bundle); resolves `AuthoredCanvas`.
- `update` with only settings (no bundle) omits the bundle part.
- `list({sourceApp})` serializes the filter to the query string; parses the `AuthoredCanvas[]`.
- `publish` returns the enriched `AuthoredCanvas` (status/metadata present); back-compat: a caller reading only `.id`/`.url` still works.
- error mapping for update-on-missing/not-owned (404) and revoked (SHARE_REVOKED).

### U5. Documentation refresh (code-as-truth)

**Goal:** the docs reflect the managed-share surface.
**Requirements:** docs convention; R2–R6, R12.
**Dependencies:** U1–U4.
**Files:** `docs/site/sdk/authoring.md`, `docs/site/api/runtime-api.md`, `docs/site/api/errors.md`, `apps/server/src/docs/generated-content.ts` (regenerated via `pnpm docs:build`).
**Approach:** document `update()`, the `metadata` field, the `list()` filter + full `AuthoredCanvas`/`status` shape, and the revoke-stays-listed semantics; add the `/v1/c/:slug/authoring/:id` PUT endpoint to the runtime-API page; add any new error code (SHARE_REVOKED) to the error table. Prefer the docs-refresh skill; run `pnpm docs:build` so llms.txt + search index + the drift guard stay green.
**Patterns to follow:** the v1 authoring docs; the docs-integrity drift guard.
**Test scenarios:** `Test expectation: none — documentation`. Verification: `pnpm build`/docs-integrity test green (every SDK error code documented; no dead links).

---

## Verification Contract

- `pnpm lint && pnpm typecheck && pnpm test` green on **both** dialects (the schema/migration unit makes this non-negotiable).
- Route tests (U3) cover AE1–AE7; SDK tests (U4) cover the new surface + back-compat.
- Manual smoke: on a dev instance with authoring on, `publish` a share, `update` it twice (URL stable, content changes), `list({sourceApp})` shows it with `status: live`, `revoke` it → URL 404s but it stays listed as `revoked`.

## Definition of Done

All five units landed; both-dialect CI green; migrations committed for pg + sqlite; SDK `update` + enriched `AuthoredCanvas`/`UpdateOptions` shipped and backward compatible; reader isolation preserved (no metadata on the public path); docs reflect the surface; `/ce-code-review` run with real findings fixed (weight the §12.0 owner/reader-isolation gates as P0). PR opened, **no direct commits to `main`**; autonomous merge only after the full matrix is green per the repo's autonomous-round contract.

---

## Scope Boundaries

**In scope:** `update()`; metadata + filtered enriched `list()`; derived `status` + revoked-stays-listed; SDK types; reader isolation; backward compat; docs.

### Deferred to Follow-Up Work
- **Team-member management** — letting a granted team also update/revoke; needs net-new management-authz (teams are view-only today).
- **DB-side metadata filter** — extracted `source_app`/`source_kind` indexed columns if the per-viewer set grows beyond the in-memory scale.
- **Un-revoke / re-activate** a revoked share (today: re-share = a fresh `publish`).
- **Delta/staged bundle uploads** for updates (the deploy engine already content-addresses dedup).

### Outside this product's identity
- Server-side rendering / a build step — canvases stay static bundles.
- Cross-app share discovery / a public share directory — shares stay owner-scoped + access-gated.
- The product-roadmap consumer app UI (separate repo).

---

## Risks & Dependencies

| Risk | Mitigation |
|------|-----------|
| **Reader metadata leak** — author/management metadata reaching a public reader. | Metadata is only assembled in the authenticated projection (KTD5); the public serve path never reads the column. AE6 test asserts it. |
| **Revoked share still readable** — unpublish not fully closing the URL. | revoke unpublishes (currentVersionId → null → content 404s) AND stamps revoked_at; a serve test asserts a revoked share's URL is unreadable. |
| **Dual-dialect migration drift** (Risk #2). | Two nullable columns added to both schema files in lockstep; migrations generated for both; parity + real-migration tests gate CI. |
| **Quota bypass via update** — treating update as a free create. | update is an in-place edit of an *existing* canvas (no new row, no new slug); it deliberately skips quota. A test asserts N updates don't change the usage count. |
| **Back-compat break** — a v1 consumer breaking on the new list/return shapes. | Return types widen (added fields, source-compatible); `list()` inclusion of revoked is intended; AE7 test asserts v1-shape calls still work. |

## Sources & Research

- Origin: this file's Product Contract (brainstorm, this session).
- v1 patterns to mirror: `apps/server/src/routes/canvas-authoring.ts`, `apps/server/src/db/repositories/authoring-usage.ts`, `packages/sdk/src/index.ts` (canvases namespace), `packages/shared/src/db/schema.{pg,sqlite}.ts`, `apps/server/src/canvas/authorization.ts` (`isAnonymouslyPublic`, `decideCanvasAccess`), `apps/server/src/deploy/engine.ts`, `apps/server/src/routes/management.ts` (unpublish/delete).
- Learnings to read first: `docs/solutions/2026-06-13-gallery-listing-patterns.md` (the dual-dialect JSON-membership trap → why in-memory filter), `docs/solutions/2026-06-13-canvas-primitives-runtime-api.md` (the `/v1/c/:slug` pipeline), `docs/solutions/2026-06-13-auth-invariant-checklist.md` (§12.0 owner/reader gates), `docs/solutions/2026-06-13-dual-dialect-drizzle-seam.md`.
