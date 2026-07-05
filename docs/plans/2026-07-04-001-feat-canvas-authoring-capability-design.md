# Canvas authoring capability — design spec

**Status:** Design (brainstorm output). Implementation plan to follow via writing-plans.
**Date:** 2026-07-04
**Author:** Mark Pasternak (with Claude)

## Problem

A canvas's own frontend cannot create another canvas. Today, canvas creation is
authorized only by a signed-in **user** principal through the foundation gateway
(`routes/management.ts` → `canvases.create({...})`, `actorId: user.id`). The two
machine paths — a **per-canvas deploy key** and the **connect-once MCP/agent** —
can deploy to an *existing* canvas or act as the interactive user, but a static
or backend-enabled canvas has no way to let *its own users* mint a new canvas
from the page.

This blocks a class of in-product feature where a signed-in viewer of canvas A
should be able to produce canvas B on demand — e.g. a roadmap tool whose users
publish an expiring, tagged, partner-facing snapshot of what they're viewing
(the consumer feature is a separate spec in the product-roadmap repo).

## Key insight

The viewer is **already authenticated**. A backend-enabled canvas serves its page
to a gateway-authenticated member and exposes that identity via the Identity
primitive (`canvasdrop.me()`). Their create-capable principal is present in the
request. So we do not need a stored service secret: a new capability can create
canvas B **as the signed-in viewer**, with real per-user ownership, gated by the
operator exactly like the AI primitive.

## Goals

- Let a backend-enabled canvas offer its **signed-in members** a way to create →
  deploy → configure (access rung, share expiry, tags) a new canvas **as
  themselves**, from the page, with no secret in the browser and nothing stored
  in the consuming canvas's repo.
- Operator-gated and quota'd, on the Backend tab, identical in shape to AI.
- Reuse the existing management services (`canvases.create`, the deploy engine,
  the sharing/update path) rather than new creation logic.

## Non-goals

- Service-account / shared-credential minting (rejected: viewer-principal is
  cleaner and gives real ownership).
- Creation via a per-canvas deploy key (keys stay deploy-only).
- The roadmap "Share this view" consumer (separate spec; depends on this).
- Arbitrary server compute / running a site build inside a canvas backend. The
  caller supplies a ready static bundle.

## Design

A new capability, working name **`authoring`**, in the same shape as AI:
Backend-tab toggle (off by default) + operator instance switch + quota, a server
route guarded by `requireCapability`, and one SDK surface.

### SDK surface (`packages/sdk`)

Minimal, one high-level call plus management, exposed as `canvasdrop.canvases`:

```ts
// Create canvas B, deploy the bundle, and apply share settings — one metered op.
canvasdrop.canvases.publish({
  title: string,
  slug?: string,                 // omitted → readable-random
  tags?: string[],
  access?: "private" | "specific_people" | "public_link" | "password",
  password?: string,             // when access === "password"
  expiresAt?: number,            // unix ms; operator may require/clamp (see quota)
  bundle: Blob | ArrayBuffer,    // the static site zip
}): Promise<{ id: string; url: string }>

// Manage what this viewer authored (scoped to their principal).
canvasdrop.canvases.list(): Promise<Array<{ id; url; title; tags; expiresAt }>>
canvasdrop.canvases.revoke(id: string): Promise<void>   // delete/unpublish
```

`publish` is atomic from the caller's view (create + deploy + configure); the
route sequences the existing services and reports a single result. `list`/`revoke`
let a consuming UI show and retract a viewer's own shares. (YAGNI: no partial
create/deploy/configure primitives exposed unless a consumer needs them.)

### Server route (`apps/server/src/routes/canvas-authoring.ts`)

Mirrors `routes/canvas-ai.ts`:

1. `requireCanvas` (canvas API isolation) + `requireCapability("authoring")`.
2. Resolve the **viewer principal** from the gateway session. **Reject** guests /
   public-link viewers with `NotAuthenticatedError` — creation needs a real
   member, and public links are static-only, so the capability is never effective
   there (consistent with the existing "Public links are static-only" rule).
3. Operator gate + quota via `AdminSettingsService` (`authoringEnabled`,
   `effectiveAuthoringQuota`) and a `checkQuota`-style check keyed by
   `actorId` (per-viewer/day + total).
4. Validate body (zod): bundle size ≤ the deploy limit; access rung within the
   operator's allowed set; `expiresAt` present/within max if the operator
   requires an expiry.
5. Execute under the viewer's principal:
   `canvases.create({ actorId: viewer.id, title, slug })` → deploy engine deploys
   `bundle` → sharing/update applies `access` / `sharedExpiresAt` / `tags` /
   optional `password`.
6. `audit.recordAudit({ action: "canvas_authored", actorId: viewer.id, targetId })`.
7. Return `{ id, url }`.

### Operator config + quota (admin)

Extend `AdminSettingsService` / `admin/config-fields.ts` with:
- `authoringEnabled` — instance master switch (like the AI provider gate). When
  off, the per-canvas toggle stays visible but labels "Disabled by your
  administrator", matching AI/Realtime.
- `authoringQuota` — defaults for: max authored canvases per viewer per day, a
  total cap, the **allowed access rungs** (e.g. operator may forbid `public_link`
  or `whole_org`), and **max share expiry** / whether an expiry is required.
  DB overrides env, resolved per request (same as `effectiveQuota`).

### Ownership, quota, and cleanup

- Canvas B is owned by the **viewer** (`actorId`), appears in *their* dashboard,
  and counts against their normal canvas quota **plus** the authoring quota.
- `revoke` deletes/unpublishes B (viewer-scoped; only the owner or an admin).
- Expiry uses the existing `sharedExpiresAt` share-expiry mechanism (it governs
  the *share*, so it is only meaningful with a shareable access rung — the
  consumer UI should pair expiry with `public_link`/`password`/`specific_people`).

## Error handling

- `CAPABILITY_DISABLED` — backend off or `authoring` toggle off.
- `NOT_AUTHENTICATED` — guest / public-link viewer.
- `QUOTA_EXCEEDED` — per-viewer/day or total authoring cap hit.
- `INVALID_BODY` — bundle too large, disallowed access rung, missing/over-max
  expiry.
- Deploy failure after create: canvas B exists but empty. Return a
  `PUBLISH_FAILED` error carrying B's id so the consumer can retry the deploy or
  call `revoke`. (Open question: auto-revoke on deploy failure vs. leave for
  retry — default to leave + return id.)

## Testing

Mirror the AI route tests (fake services injected):
- capability off → `CapabilityDisabledError`.
- guest/public viewer → `NotAuthenticatedError`.
- quota exceeded → `QuotaExceededError`.
- disallowed access rung / over-max expiry → `INVALID_BODY`.
- happy path: `publish` creates with `actorId = viewer.id`, deploys the bundle,
  applies access/expiry/tags, records the audit, returns `{ id, url }`.
- `revoke` only affects the viewer's own authored canvas.

## Open questions

1. **Naming:** `authoring` vs `canvases` vs `shares` for the capability + SDK
   namespace. (Leaning `authoring` capability, `canvasdrop.canvases.*` SDK.)
2. **Quota model:** does an authored canvas count only against the authoring
   quota, or also the viewer's normal canvas quota? (Leaning both.)
3. **Deploy-failure cleanup:** auto-revoke the empty canvas, or return its id for
   retry? (Leaning return-id.)
4. **Bundle transport:** direct zip in the `publish` body (simple, size-limited)
   vs. the content-addressed staged upload the deploy API already supports (sends
   only changed bytes — better for re-publishes). Start with direct zip; adopt
   staged upload if re-publish size becomes a problem.
