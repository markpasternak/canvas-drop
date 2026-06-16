---
title: "feat: Custom canvas slugs"
type: feat
status: active
date: 2026-06-16
origin: docs/brainstorms/2026-06-16-custom-slugs-requirements.md
---

# feat: Custom canvas slugs

## Summary

Let an authenticated owner choose a custom slug for a canvas instead of always receiving the
random readable-random one (`quiet-otter-x7k2m9…`). The slug field sits below Title on the
create form (all four methods) and is left empty to keep today's random default. Owners can
also change a canvas's slug after creation by folding a "set your own" path into the existing
slug-regeneration flow. Slugs are validated against one DNS-safe grammar + a reserved-word
blocklist + uniqueness, enforced server-side and surfaced live in the UI via an availability
endpoint. A canvas that is both publicly reachable by link and carries a custom slug shows an
informational heads-up that its URL is human-guessable.

This is a deliberate post-v1 evolution of `BUILD_BRIEF.md` D3 ("No custom names in v1"); the
brainstorm (see origin) records the decision and its trust-model rationale.

---

## Problem frame

Every slug today is minted by `generateUniqueSlug` (`apps/server/src/canvas/slug.ts`) from
three server entry points — `POST /api/canvases` (create), `POST /api/canvases/paste`, and
`POST /api/canvases/:id/regenerate-slug` (`apps/server/src/routes/management.ts`) — plus MCP
and clone. The slug is unguessable by design, which `BUILD_BRIEF.md` §4.6/§12.1.4 treats as
defense-in-depth for the sharing access ladder. Random slugs are unmemorable; owners want
human-readable URLs they choose. The ask: accept an optional custom slug, fall back to random
when empty, validate it (DNS-safe so it works in subdomain mode — prod's mode), and warn on a
taken slug — without ever making obscurity the *only* control.

---

## Requirements

Carried from the origin requirements doc:

- **R1** — Owner can set a custom slug at create time (all four methods); empty → random
  (unchanged default).
- **R2** — Owner can change an existing canvas's slug to a custom value after creation.
- **R3** — Invalid or already-taken slugs are caught with clear inline feedback before submit,
  and rejected server-side even if the client check is bypassed.
- **R4** — A custom slug works identically in path mode (`/c/{slug}/`) and subdomain mode
  (`{slug}.host`): one DNS-safe grammar.
- **R5** — A publicly-reachable canvas with a custom slug shows a human-guessable heads-up in
  the share flow.

Success criteria (origin): empty→random unchanged; valid custom slug reachable at that exact
slug; invalid/taken rejected inline AND server-side; rename invalidates old URL + drops
sockets + serves at new slug; public+custom shows the heads-up; both dialects green with tests
covering the server-side rejection paths and the check-then-act race.

---

## Key technical decisions

- **KTD1 — One dependency-free slug-policy module is the single source of truth.** Add a leaf
  module (e.g. `packages/shared/src/canvas/slug-policy.ts`, exported as `@canvas-drop/shared/
  slug`) exporting `normalizeSlug(raw)` and `validateSlug(slug)` (grammar + reserved-word
  check, returning a typed reason on failure) plus the reserved-word list. It must import **no
  node built-ins** so it is bundle-safe. The server imports it directly; uniqueness is layered
  on top by the route (DB lookup). Keeps grammar in lockstep with the existing `generateSlug`
  output (which already satisfies the grammar).
- **KTD2 — The client does NOT import shared validation; it calls an availability endpoint.**
  The dashboard SPA does not depend on `@canvas-drop/shared` and importing it risks pulling
  server-only code into the browser bundle. Instead the client does **cosmetic** normalization
  inline (lowercase, spaces/invalid runs → single hyphen) for the live URL preview, and calls
  a new debounced `GET …/slug-available` endpoint for authoritative grammar + reserved +
  uniqueness feedback. Server remains the only authority; no duplicated grammar to drift.
- **KTD3 — DNS-safe grammar everywhere.** Allowed: lowercase `a–z`, `0–9`, hyphen; length 1–63;
  no leading/trailing hyphen; not reserved; unique. Enforced for both create and rename
  regardless of URL mode (origin decision: prod is subdomain mode).
- **KTD4 — Uniqueness is closed atomically by the existing unique index.** `canvases_slug_uq`
  already exists in both dialect schemas. The availability check is advisory UX; create/paste/
  rename catch the unique-constraint violation and return a `409 slug_taken`, closing the
  check-then-act race. No new locking.
- **KTD5 — Persist a `slug_custom` boolean** on the canvas row to drive the public+custom
  heads-up (a random slug that happens to look custom must not trip it, and vice-versa). Set
  `true` when a custom slug is accepted (create or rename), `false` when random. Dual-dialect
  column + parity test + generated migration `0019`.
- **KTD6 — Rename reuses `regenerate-slug` semantics.** `POST /:id/regenerate-slug` gains an
  optional `{ slug? }` body: absent/empty → random (`slug_custom=false`, existing behavior);
  present → validate + set custom (`slug_custom=true`). It already invalidates old URLs, drops
  live sockets (`deps.hub?.dropCanvas`), and audits `slug_regen` — all unchanged.
- **KTD7 — Dialect-aware unique-violation detection (net-new, not a no-op).** There is **no
  existing catch-the-constraint-throw pattern** in the repo — every current dedup uses
  `onConflictDoUpdate`. Catching the `canvases_slug_uq` violation is new code, and the error
  shape differs by driver: better-sqlite3 → `err.code === "SQLITE_CONSTRAINT_UNIQUE"` + index
  name in the message; node-postgres → `err.code === "23505"` + `err.constraint`; **pglite**
  (the postgres *test* leg) must be verified to match. A naïve `catch → 409` would also swallow
  the table's other unique index (`canvases_api_key_hash_uq`) and mis-map it to `slug_taken`.
  Introduce one shared helper `isUniqueViolation(err, indexName)` (db layer) with explicit
  SQLite-message and Postgres-`constraint` branches, and run the race test on **both** legs.
- **KTD8 — Slug uniqueness vs. soft-deleted rows.** `canvases_slug_uq` is **unconditional**
  (no status predicate), but `findBySlug` excludes soft-deleted rows. So a slug occupied by a
  `deleted` canvas (incl. the paste path's own orphan-cleanup tombstone) would read *available*
  via `findBySlug` yet 409 on insert — the advisory check and the authoritative constraint
  disagree. **Decision (lowest-risk pre-v1):** the availability endpoint and the create/rename
  precheck use a **status-unaware** slug lookup that matches the unconditional index, so "green"
  means "insertable." Do not change the index to partial (SQLite/Postgres partial-index syntax
  diverges; unnecessary here).
- **KTD9 — One shared `SlugField` resolves the UI status mechanism.** `Field` has no error/
  status slot and `description` renders muted text with no `aria-live`. Rather than leave the
  mechanism to each implementer (U6 and U7 would diverge), build one `SlugField` component +
  `useSlugAvailability` hook used by both: it owns cosmetic normalization, the debounced
  availability call, the live URL preview, the full state set (idle / checking / available /
  taken / invalid / reserved) with distinct styling, and an `aria-live="polite"` status region
  wired via `aria-describedby`.
- **KTD10 — Client URL preview needs instance URL config.** `/api/me` exposes `authMode` (UX-
  only instance config) but not URL mode or base URL, so the client cannot render a faithful
  `/c/{slug}/` vs `{slug}.{host}` preview. Expose `urlMode` and `baseUrl` on `/api/me` (same
  "instance config, never an authz signal" rationale as `authMode`); the preview template is
  path mode → `{baseUrl}/c/{slug}/`, subdomain mode → `{slug}.{host of baseUrl}`.

---

## Scope boundaries

**In scope**
- Optional slug on `POST /api/canvases` and `POST /api/canvases/paste`; optional slug on
  `POST /api/canvases/:id/regenerate-slug`.
- `GET /api/canvases/slug-available?slug=` availability endpoint.
- Shared slug-policy module (normalize + validate + reserved list) and a dialect-aware
  `isUniqueViolation` helper.
- `slug_custom` column (both dialects), `canvasView` exposure, dashboard `Canvas` type.
- `urlMode` + `baseUrl` on `/api/me` for the client URL preview.
- A shared `SlugField` + `useSlugAvailability` (states, debounce, preview, a11y), consumed by
  the create form and the settings rename flow.
- Settings "change slug" UI (custom path added to the regen flow).
- Public + custom-slug heads-up in the share view.

**Deferred to follow-up work**
- Optional `slug` parameter on MCP `create_canvas` / the keyed deploy API (agents keep random
  slugs).
- Old-slug redirects or "parking" on rename — old URLs 404 immediately (matches today).
- Cross-instance / cross-org slug reservation.
- Clone (`POST /:id/clone`) keeps minting a random slug — out of scope.

---

## Open questions (resolve during implementation)

- **Final reserved-word list.** Seed from `RESERVED_API_PREFIXES`
  (`apps/server/src/dashboard/serve-spa.ts`, stripped of slashes) plus subdomain reserves
  (`www`, `app`, `admin`, `docs`, `gallery`, `api`, `auth`, `sdk`, `mail`, `static`) **plus the
  root-level mount points the security pass found missing: `mcp`, `healthz`, `welcome`,
  `skill`.** U1 must do a mechanical pass through `apps/server/src/app.ts` mount points and add
  any single-label path that would shadow a real route in subdomain mode (the app provides no
  authoritative enumerable source — this is a curated superset, deliberately). Note the
  deployment layer (Caddy/DNS) is the real subdomain authority and is outside the codebase.
- **Availability response shape.** Proposed: `{ available: boolean, reason?: "invalid" |
  "reserved" | "taken" }`. Finalize in U4.
- **Old slug reuse after rename.** Default: immediately claimable (matches today). No
  impersonation mitigation under the trusted-org model unless review disagrees.

---

## Implementation units

### U1. Shared slug-policy module

**Goal:** One bundle-safe source of truth for slug normalization, grammar validation, and the
reserved-word list.
**Requirements:** R3, R4.
**Dependencies:** none.
**Files:**
- `packages/shared/src/canvas/slug-policy.ts` (new)
- `packages/shared/src/canvas/slug-policy.test.ts` (new)
- `packages/shared/package.json` (add the `./slug` export if a subpath export is used)
- `packages/shared/src/index.ts` (re-export if appropriate)

**Approach:** Export `normalizeSlug(raw): string` (lowercase; collapse spaces and runs of
invalid chars to a single hyphen; trim leading/trailing hyphens) and `validateSlug(slug):
{ ok: true } | { ok: false; reason: "invalid" | "reserved" }`. Export `RESERVED_SLUGS` (a
`Set`/array) including the reconciled list above (`mcp`, `healthz`, `welcome`, `skill`, …). No
node imports — pure string logic only, so the dashboard could consume it later without bundle
risk. Mirror the grammar the existing `generateSlug` already satisfies.
**Patterns to follow:** existing shared leaf modules under `packages/shared/src/` (e.g.
`db/publication-state.ts` exported via `@canvas-drop/shared/db`).
**Test scenarios:**
- `normalizeSlug` happy: `"My Prototype"` → `"my-prototype"`; `"a  b__c!!d"` → `"a-b-c-d"`.
- `normalizeSlug` edges: leading/trailing spaces/hyphens trimmed; all-invalid input → `""`;
  unicode/emoji stripped.
- `validateSlug` happy: `"team-dashboard"` → ok.
- `validateSlug` grammar failures: empty, `"-lead"`, `"trail-"`, uppercase, `"a_b"`, 64 chars
  → `reason:"invalid"`.
- `validateSlug` reserved: each reserved word → `reason:"reserved"`.
- `validateSlug` boundary: exactly 1 char ok; exactly 63 chars ok; 64 rejected.

---

### U2. `slug_custom` column (dual-dialect) + migration

**Goal:** Persist whether a canvas's slug was user-chosen.
**Requirements:** R5 (and supports KTD5).
**Dependencies:** none.
**Files:**
- `packages/shared/src/db/schema.sqlite.ts`
- `packages/shared/src/db/schema.pg.ts`
- `packages/shared/src/db/schema.test.ts` (parity)
- `drizzle/sqlite/0019_*.sql` (generated)
- `drizzle/pg/0019_*.sql` (generated)
- `apps/server/src/db/repositories/canvases.ts` (`CreateCanvasInput`, `create`, `regenerateSlug`)
- `apps/server/src/db/unique-violation.ts` (new — `isUniqueViolation` helper) + its test

**Approach:** Add `slugCustom: c.bool("slug_custom").notNull().default(false)` to the
`canvases` table in **both** dialect builders (mirror the `galleryTemplatable` pattern at
schema.*.ts:151). Generate migrations with drizzle-kit using `drizzle.sqlite.config.ts` and
`drizzle.pg.config.ts` (next sequence is `0019`; do not hand-renumber). Thread an optional
`slugCustom` through `CreateCanvasInput` (default false) and add a `custom` flag to
`regenerateSlug(id, newSlug, custom)`. Add the `isUniqueViolation(err, indexName)` helper
(KTD7): a SQLite branch (`err.code === "SQLITE_CONSTRAINT_UNIQUE"` AND the index name appears
in `err.message`) and a Postgres branch (`err.code === "23505"` AND `err.constraint ===
indexName`). It must return false for the `canvases_api_key_hash_uq` index so unrelated
failures are never mis-mapped.
**Patterns to follow:** `galleryTemplatable` boolean column; the dual-dialect column helper
seam (see `docs/solutions/2026-06-13-dual-dialect-drizzle-seam.md`).
**Test scenarios:**
- Schema-parity test stays green with the new column present in both dialects.
- `create` with no `slugCustom` persists `false`; with `true` persists `true` (both dialects).
- `regenerateSlug(id, slug, true)` sets `slug_custom=true`; `(id, slug, false)` sets `false`.
- `isUniqueViolation`: a real `canvases_slug_uq` throw → true on **both** sqlite and pglite/pg
  legs; an unrelated error (or a `canvases_api_key_hash_uq` throw) → false.
- `Covers AE: migrate-populated` — existing populated-DB migration test still passes with the
  added column defaulting to false on existing rows.

---

### U3. Server: accept + validate custom slug on create & paste

**Goal:** `POST /api/canvases` and `POST /api/canvases/paste` accept an optional `slug`,
validate it server-side, set it (and `slug_custom`), and reject invalid/taken slugs.
**Requirements:** R1, R3, R4.
**Dependencies:** U1, U2.
**Files:**
- `apps/server/src/routes/management.ts` (`createSchema`, the `/` and `/paste` handlers,
  `canvasView`)
- `apps/server/src/routes/management.test.ts` (or the colocated app test)

**Approach:** Add optional `slug: z.string()` to `createSchema` and the paste body schema. When
present: `normalizeSlug` is a client concern — server validates the raw value with
`validateSlug` (reject `invalid`/`reserved` → `400`), then attempt `canvases.create({ slug,
slugCustom: true, … })`; catch a `canvases_slug_uq` violation (via `isUniqueViolation`, KTD7)
and return `409 { error: "slug_taken" }`. When absent: keep `generateUniqueSlug` (slugCustom
defaults false). Expose `slugCustom` in `canvasView`.
**Paste ordering (KTD8 / feasibility finding):** a taken custom slug throws inside
`canvases.create` — **before** any canvas row exists and before the deploy `try` block — so the
slug-taken 409 must be caught around `create`, where there is no orphan to clean up. The
existing deploy-failure soft-delete (management.ts:911) remains a separate, later concern and
does NOT cover this case. The soft-delete tombstone keeps the slug reserved in the
unconditional unique index, which is why the availability check must be status-unaware (KTD8).
**Patterns to follow:** existing `safeParse` + `c.json({ error }, 400)` shape; the paste
soft-delete-on-failure cleanup at management.ts:911 (deploy failures only).
**Test scenarios:**
- Create with valid custom slug → 201, canvas reachable at that slug, `slugCustom:true` in view.
- Create with empty/omitted slug → 201 with a random slug, `slugCustom:false` (regression).
- Create with invalid slug (uppercase, leading hyphen, 64 chars) → 400.
- Create with reserved slug (`api`, `www`) → 400.
- Create with a slug already taken → 409 `slug_taken`.
- **Race:** two concurrent creates with the same valid slug → exactly one 201, the other 409
  (unique index, not a pre-check). `Covers AE: check-then-act race`.
- Paste with valid custom slug → 201 + deployed; paste with taken slug → 409 and **no orphan**
  canvas left behind.
- Identity/authorization unchanged: slug is owner-scoped; no client-asserted identity.

---

### U4. Server: slug-availability endpoint

**Goal:** A lightweight authoritative check for live UX feedback.
**Requirements:** R3.
**Dependencies:** U1.
**Files:**
- `apps/server/src/routes/management.ts` (new `GET /slug-available`)
- `apps/server/src/routes/management.test.ts`

**Approach:** `GET /api/canvases/slug-available?slug=<raw>`. **Register this route BEFORE
`app.get("/:id", …)` (currently management.ts:358)** — Hono resolves in registration order, so
registered after `/:id` it would be captured as `id="slug-available"` and 404 via `ownedCanvas`
(security finding 3). Authenticated via the session gateway only; **do NOT add `sameOrigin`** —
that guard is for mutating routes; every read GET in this router omits it (security finding 5).
Run `validateSlug`; if invalid/reserved return `{ available:false, reason }`; else do a
**status-unaware** slug lookup (KTD8 — matches the unconditional index, not `findBySlug`) and
return `{ available: <not found>, reason: found ? "taken" : undefined }`. The response carries
**only** `{ available, reason? }` — no canvas id/title/owner/access (security finding 4). Read-
only, cheap; the broad authed rate limiter (app.ts) already applies.
**Patterns to follow:** existing authed GET handlers in the canvases router; the `me`/`/:id`
ordering note at me.ts:22-23 (same "/:id would match" hazard).
**Test scenarios:**
- Valid + free slug → `{ available:true }`.
- Valid + taken slug → `{ available:false, reason:"taken" }` — and the body contains **no**
  other canvas fields, even when the taken canvas is owned by a different user.
- A slug occupied only by a soft-deleted canvas → reports `taken` (agrees with the insert).
- Invalid grammar → `{ available:false, reason:"invalid" }`.
- Reserved word (incl. `mcp`) → `{ available:false, reason:"reserved" }`.
- `GET /api/canvases/slug-available?slug=foo` resolves to the availability handler (not a
  `404` canvas-by-id) — guards against the registration-order regression.
- Unauthenticated request → rejected (same as sibling routes).

---

### U5. Server: optional custom slug on rename (regenerate-slug)

**Goal:** Fold a "set your own slug" path into `POST /:id/regenerate-slug`.
**Requirements:** R2, R3, R4.
**Dependencies:** U1, U2.
**Files:**
- `apps/server/src/routes/management.ts` (the `/:id/regenerate-slug` handler at :707)
- `apps/server/src/routes/management.test.ts`

**Approach:** Parse an optional `{ slug? }` body. Absent/empty → existing random path
(`generateUniqueSlug`, `regenerateSlug(id, slug, false)`). Present → `validateSlug` (400 on
fail), `regenerateSlug(id, slug, true)`, mapping a `canvases_slug_uq` violation (via
`isUniqueViolation`, KTD7) to `409 slug_taken`. Preserve the socket drop (`deps.hub?.dropCanvas`)
and `slug_regen` audit in both paths.
**Patterns to follow:** the current regenerate-slug handler; the create-path collision handling
from U3.
**Test scenarios:**
- Rename with valid custom slug → 200, `slugCustom:true`, served at new slug.
- Rename with empty body → random slug, `slugCustom:false` (regression of today's behavior).
- Rename with invalid/reserved slug → 400.
- Rename to a taken slug → 409 `slug_taken`.
- Rename drops live sockets and writes the `slug_regen` audit (both random and custom paths).
- **Integration:** old slug URL 404s after rename; new slug resolves.

---

### U9. Server: expose URL mode + base URL on `/api/me`

**Goal:** Give the dashboard the instance URL config it needs to render a faithful slug URL
preview (KTD10).
**Requirements:** R1 (preview), R4.
**Dependencies:** none.
**Files:**
- `apps/server/src/routes/me.ts` (add `urlMode`, `baseUrl` to the explicit projection)
- `apps/server/src/routes/management.test.ts` (the `/api/me` projection test at :877)
- `apps/dashboard/src/lib/api.ts` (`Me` type gains `urlMode`, `baseUrl`)

**Approach:** Add `urlMode` and `baseUrl` to the `/api/me` JSON, sourced from `deps.config`
(thread the needed config into `MeRoutesDeps`). Same rationale as the existing `authMode`:
instance config, UX-only, **never an authz signal** — keep the explicit-projection discipline
(no row spread). Path mode preview → `{baseUrl}/c/{slug}/`; subdomain mode → `{slug}.{host of
baseUrl}`.
**Patterns to follow:** the `authMode` field + the "explicit field projection, no spread leak"
note in me.ts:25.
**Test scenarios:**
- `/api/me` returns `urlMode` and `baseUrl` and still **only** the projected fields (extend the
  existing no-spread-leak test).
- Values reflect the configured mode in both path- and subdomain-configured app instances.

---

### U10. Dashboard: shared `SlugField` + `useSlugAvailability`

**Goal:** One component + hook that owns the entire slug-input UX, consumed by U6 (create) and
U7 (rename), so the two surfaces can't diverge (KTD9; design findings 1, 2, 3, 7).
**Requirements:** R1, R3, R4.
**Dependencies:** U4, U9.
**Files:**
- `apps/dashboard/src/components/SlugField.tsx` (new)
- `apps/dashboard/src/lib/use-slug-availability.ts` (new — debounced hook)
- `apps/dashboard/src/lib/cosmetic-slug.ts` (new — cosmetic normalize for preview only)
- `apps/dashboard/src/lib/api.ts` (`slugAvailable(slug)` client call)
- `apps/dashboard/src/test/*` (component + hook tests)

**Approach:**
- **Cosmetic normalize** (preview only; server is authority): lowercase, spaces/invalid runs →
  single hyphen.
- **Live URL preview** built from the typed slug + `me.urlMode`/`me.baseUrl` (U9), per KTD10.
- **`useSlugAvailability`**: debounce **400 ms**; calls `api.slugAvailable`; exposes a single
  status union `idle | checking | available | taken | invalid | reserved`. Rapid typing
  collapses to one trailing request.
- **States + copy:** idle shows the static helper "Leave empty for a random URL" (outside the
  live region); the other states render in a status node with distinct (non-muted) styling for
  the error-ish states (`taken`/`invalid`/`reserved`) — resolving the `Field` no-error-slot gap
  once (design finding 1).
- **Accessibility:** the status node is a separate `role="status"` / `aria-live="polite"`
  region wired to the input via `aria-describedby` (design finding 7).
- Expose the current status to the parent so create/rename can gate their submit button.
**Patterns to follow:** `Field` composition (`useId`, label/hint); `InlineNotice` styling
tokens for the error-ish states; existing dashboard hooks under `lib/`.
**Test scenarios:**
- Cosmetic: `"My App"` → preview slug `my-app`; preview URL matches path vs subdomain mode.
- Debounce: N rapid keystrokes → exactly one trailing `slugAvailable` call.
- Each backend reason maps to its state: free→available, taken→taken, bad grammar→invalid,
  reserved→reserved; in-flight→checking.
- idle (empty/untouched) shows the helper text, not an error, and is not in the live region.
- The status region carries `role="status"`/`aria-live` and `aria-describedby` links it to the
  input.

---

### U6. Dashboard: create-form slug field

**Goal:** Place the shared `SlugField` (U10) below Title and wire the chosen slug into all four
create methods.
**Requirements:** R1, R3.
**Dependencies:** U3, U10.
**Files:**
- `apps/dashboard/src/routes/new.tsx`
- `apps/dashboard/src/lib/api.ts` (`createCanvas`, `pasteHtml` accept `slug?`; add `slugCustom`
  to `Canvas` type)
- `apps/dashboard/src/test/*` (create-flow test)

**Approach:** Render `SlugField` (U10) under the Title `Field` at new.tsx:241, in create mode
(no current canvas → preview built from typed slug + instance URL config from U9). Hold the
field's confirmed-validity in local state; disable the create/publish action when the slug is
non-empty AND status is not `available` (idle-not-yet-checked, checking, taken, invalid, and
reserved all block — design finding 3). Pass `slug || undefined` into `createPaste`,
`createWithUpload`, and `createApiOnly`. Surface a server `409 slug_taken` / `400` via the
existing `fail()` path without clearing the form.
**Patterns to follow:** existing busy/error state in new.tsx; `ApiError.hint` surfacing.
**Test scenarios:**
- Available slug → action enabled; taken → action disabled; invalid/reserved → action disabled.
- Empty slug → action enabled, submits with no slug (random path).
- Each method (paste/folder/zip/api) sends the chosen slug; server 409 surfaces as an inline
  error without losing form state.

---

### U7. Dashboard: rename (change slug) UI in settings

**Goal:** Add a custom-slug path to the existing Settings → "Regenerate slug" flow.
**Requirements:** R2, R3.
**Dependencies:** U5, U10.
**Files:**
- `apps/dashboard/src/routes/canvas.settings.tsx`
- `apps/dashboard/src/lib/mutations.ts` (`useRegenerateSlug` accepts optional `slug`)
- `apps/dashboard/src/lib/api.ts` (`regenerateSlug(id, slug?)`)
- `apps/dashboard/src/components/*` (a form-capable dialog if `ConfirmDialog` can't carry a
  value — see below)
- `apps/dashboard/src/test/*` (settings test)

**Approach:** The current slug action uses `ConfirmDialog`, which only takes a void `onConfirm`
and can't carry a typed value (design finding 4). Replace it with a small form dialog (either a
new `ConfirmDialog` form variant or a locally-composed dialog) that: wraps content in a `<form
onSubmit>`; renders the `SlugField` (U10, optional input) above the consequence copy;
**auto-focuses the slug input** (not the confirm button); submits the value to the parent.
Empty input → random (today's behavior); filled → custom. Block submit while the entered slug
isn't `available`. Keep the post-action focus-to-copy behavior. **Update the consequence copy**
to state both effects (design finding 5): the old URL stops working AND current visitors are
disconnected and must reload. `api.regenerateSlug` and `useRegenerateSlug` take an optional slug.
**Patterns to follow:** the existing slug `ConfirmDialog` copy + shared-canvas wording; the
`SlugField`/`useSlugAvailability` from U10 (no duplicated availability logic).
**Test scenarios:**
- Confirm with empty input → random regen (regression).
- Confirm with valid custom slug → renames; toast + new URL shown.
- Taken/invalid/reserved slug → inline feedback, confirm blocked.
- Consequence copy shows BOTH the URL-break and the live-disconnect warning; shared-canvas
  wording preserved.

---

### U8. Dashboard: public + custom-slug heads-up

**Goal:** Inform owners when a publicly-reachable canvas uses a guessable custom slug.
**Requirements:** R5.
**Dependencies:** U2 (`slugCustom` exposed in `canvasView` + `Canvas` type), U3.
**Files:**
- `apps/dashboard/src/routes/canvas.share.tsx` (the `AccessLadder`, ~:403)
- `apps/dashboard/src/test/share.test.tsx`

**Approach:** When `canvas.slugCustom` is true AND the access rung is link-reachable
(`whole_org` or `public_link`), render an informational notice: the URL is human-readable/
guessable, so obscurity is not protecting it — rely on the access controls. Informational only,
never a blocker. **Placement (design finding 6):** the existing notice renders only for
`public_link`; `whole_org` has no anchor today. Render the heads-up once, after the
`AccessLadder` fieldset, gated on `slugCustom && (access==="whole_org" || access==="public_link")`
— so it covers both rungs and does not stack a second box inside the `public_link` static-only
warning. Use `tone="accent"` (informational) to distinguish it from the `public_link`
behavior-limitation `tone="warning"`.
**Patterns to follow:** the existing `InlineNotice` shown for `public_link` (share.tsx:403);
`InlineNotice` tone variants.
**Test scenarios:**
- Custom slug + `public_link` → heads-up shown (alongside, not nested in, the static-only note).
- Custom slug + `whole_org` → heads-up shown.
- Custom slug + `private`/`specific_people` → no heads-up.
- Random slug + `public_link` → no heads-up (only the existing static-only notice).
- Changing access from `private` → `whole_org` on a `slugCustom` canvas shows the heads-up
  without reload (reactive on the live `canvas` prop).

---

## System-wide impact

- **Security/trust model:** widens slug-space from unguessable-only to owner-chosen. Obscurity
  was always defense-in-depth (§4.6); real controls (auth, password gate, guest invites,
  public-link admin gating) are unchanged. The heads-up (U8) makes the trade-off visible at the
  one place it matters. Review against `docs/solutions/2026-06-13-auth-invariant-checklist.md`
  — slug is never an identity or authorization input, so this does not touch a §12.0 invariant.
- **Dual-dialect:** U2 adds a column to both schemas + a migration per dialect; the parity test
  and CI matrix must stay green on sqlite and postgres.
- **No change** to MCP create, clone, the deploy API, or the random generator.

---

## Risks & dependencies

- **R-1 Migration on populated prod DB.** Prod (canvas-drop.com) has data. Adding
  `slug_custom NOT NULL DEFAULT false` is additive and safe; verify the generated `0019`
  migrations apply cleanly via the boot-time `runMigrations` path and the populated-DB
  migration test.
- **R-2 Bundle safety.** The shared policy module (U1) must stay node-free; the dashboard must
  NOT import it (KTD2). Guard by keeping client validation to the availability endpoint +
  cosmetic normalize.
- **R-3 Reserved-list completeness.** An incomplete blocklist could let a slug shadow a system
  subdomain/route in subdomain mode (e.g. `mcp`). Reconcile the list against `app.ts` mount
  points in U1 and add a test per reserved word.
- **R-4 Dialect-divergent error handling.** The unique-violation→409 catch (KTD7) must be
  proven on the pglite test leg, not just sqlite — the race/`slug_taken` tests run on both legs.

> Plan reviewed via `/ce-doc-review` (feasibility, security-lens, design-lens; coherence agent
> hit a worktree path glitch and was reconciled by hand). All P0/P1 findings folded in above:
> dialect-aware unique-violation handling + soft-delete/index semantics (KTD7/KTD8), expanded
> reserved list (U1), availability-route ordering/guard/no-leak (U4), shared `SlugField` for the
> error-slot + a11y + preview gaps (U10), `/api/me` URL config (U9), and the rename form-dialog +
> consequence copy (U7).

---

## Sources & research

- Origin: `docs/brainstorms/2026-06-16-custom-slugs-requirements.md`
- `apps/server/src/canvas/slug.ts` (generator + `generateUniqueSlug`)
- `apps/server/src/routes/management.ts` (create/paste/regenerate-slug, `canvasView`)
- `packages/shared/src/db/schema.{sqlite,pg}.ts` (`canvases`, `canvases_slug_uq`)
- `apps/server/src/db/repositories/canvases.ts` (`create`, `findBySlug`, `regenerateSlug`)
- `apps/dashboard/src/routes/{new,canvas.settings,canvas.share}.tsx`, `lib/{api,mutations}.ts`
- `apps/server/src/dashboard/serve-spa.ts` (`RESERVED_API_PREFIXES`)
- Learnings: `docs/solutions/2026-06-13-dual-dialect-drizzle-seam.md`,
  `2026-06-15-canvas-publication-state-vocabulary.md`,
  `2026-06-13-auth-invariant-checklist.md`
