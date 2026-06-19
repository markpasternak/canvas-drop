# Dashboard UX Sweep — 13 Improvements (Requirements)

> Started as a top-10 UX sweep; three concepts added during brainstorm: #11 unified canvas tags + filtering, #12 default gallery view with persisted preference, #13 smarter forgiving search.

- **Date:** 2026-06-19
- **Status:** Ready for planning (`/ce-plan`)
- **Branch / worktree:** `feat/ux-sweep-top10` → `../canvas-drop-ux-sweep`
- **Delivery:** one autonomous sweep PR (all 13 items), dashboard-app-focused, with a small additive backend where noted.

## Outcome

The dashboard already has strong foundations (semantic tokens, dark mode, real skeleton/empty/error states, deterministic generative covers, a coherent IA). This sweep raises **hierarchy, state clarity, mobile density, and scannability** across the owner list, gallery, canvas detail, create flow, and admin overview — without changing the product's identity or the auth/access model.

## Decisions locked (from brainstorm)

- **Backend reach:** small additive backend allowed (dual-dialect migrations, MCP parity where owner-facing). Anything beyond that was checked back and approved per-item below.
- **Covers (#3):** content-aware generative *fallback* only. No screenshot-capture pipeline work.
- **Sparse dashboard (#1):** additive "finish this" strip, not a full dashboard replacement.
- **Settings tiers (#8):** visual re-tiering only — no change to the existing confirmation flow.
- **Gallery featured (#4):** real editorial **featured** flag, **admin-curated** (cross-owner → admin routes, exempt from per-account MCP parity, matching the existing public-link-gating model).
- **Admin lane (#10):** derivable signals only — no trend history, no screenshot-failure tracking.
- **Tags (#11):** **unified** — a canvas carries ONE tag set used for both personal owner-list filtering and (when listed) public gallery display. Owner-facing → MCP + docs updated. Reuses the existing `galleryTags` field (no destructive migration); exposed as `tags` everywhere with one consistent visual + filter control.
- **Default view (#12):** owner canvas list defaults to **gallery/grid**; an explicit toggle to list persists to `localStorage` (per-device); `?view=` URL param overrides. Precedence: URL > localStorage > default (grid).
- **Smarter search (#13):** **portable normalized-substring** matching (case/accent/spacing-forgiving, multi-word AND, identical on both dialects — no dialect-specific FTS/trigram), across **title + description (gallerySummary) + tags + slug**, applied to **both** the owner list and the gallery.

## The improvements

References are repo-relative; line/size detail came from a code scan and should be re-verified during planning.

### 1. Task-first sparse dashboard
- **Where:** `apps/dashboard/src/routes/index.tsx`, `apps/dashboard/src/components/CanvasList.tsx`
- **Behavior:** when the library is sparse, render a prominent "finish this canvas" strip **above** the normal list; keep stats chips + filters intact (additive, reversible as the library grows).
- **Sparse trigger (default, confirm in plan):** few active canvases (e.g. ≤ 3) **or** the most-recent canvas is still a draft. First-run (zero canvases) keeps routing to Onboarding.
- **Strip content:** the canvas needing attention — title, status, the single next step ("Publish to get a live URL"), and primary actions (Open draft / Publish; Share when published).
- **Acceptance:** strip appears only when sparse; disappears once the library grows past the threshold; never shown alongside the zero-state; keyboard-reachable; primary action is the obvious next step for that canvas's state.

### 2. State-specific empty states
- **Where:** `apps/dashboard/src/components/EmptyState.tsx` (extend the single shared component), consumed in `routes/index.tsx`, `routes/gallery.tsx`.
- **Behavior:** distinct copy + exactly one targeted action per state, preserving the user's context:
  - empty **archived** → "View active canvases"
  - empty **search** → "Clear search" (clears only `q`, keeps other filters)
  - empty **filtered** list → "Clear all filters"
  - empty **gallery** result → "Clear filters" / "Browse docs"
  - **first-run** → "Create a canvas" (+ docs link)
- **Acceptance:** each state shows the right action; "Clear search" preserves non-search filters; no two states share generic copy; the forbidden generic strings (e.g. "Nothing here yet") never appear.

### 3. Content-aware fallback covers
- **Where:** `apps/dashboard/src/components/GenerativeCover.tsx`, `apps/dashboard/src/components/CanvasCover.tsx`
- **Behavior:** keep real screenshots where `hasPreview` is true (via the existing access-gated `previewCoverUrl`). Upgrade the generative *fallback* to be content-aware: embed the **title**, **type** (e.g. canvas/template), and **status** over the existing deterministic OKLCH mesh so covers aid recognition, not just decorate.
- **Acceptance:** a fallback cover is visually distinguishable between two canvases of different title/type/status; remains deterministic per canvas id; stays `aria-hidden` (title remains the accessible affordance); no layout shift vs. today's aspect ratios; renders with no new runtime image deps.
- **Security:** fallback covers display only metadata the viewer can already see; the screenshot `previewCoverUrl` stays access-gated (R5). No private-content path is introduced.

### 4. Gallery redesign for scanning
- **Where:** `apps/dashboard/src/routes/gallery.tsx`, gallery query/types in `apps/dashboard/src/lib/api.ts` + `queries.ts`; server gallery list + admin canvases route.
- **Behavior:**
  - **Featured row** — admin-curated, surfaced at top (only listed+published canvases).
  - **Recently published row** — derived from `publishedAt`.
  - **Top-tag shortcut chips** — computed from existing `galleryTags`; click filters `?tag=`.
  - **Sort dropdown** — Featured / Trending (`recentViews`) / Recent / Title.
  - Clearer per-card owner + type metadata; more prominent "Use template" on templatable items.
- **Acceptance:** Featured row shows only canvases an admin flagged AND that are still listed/published (a canvas that unlists/unpublishes drops out); Trending sort orders by `recentViews`; tag chips reflect actual tags present; sort + tag state is URL-driven and shareable like existing filters.

### 5. Mobile canvas cards & action overflow
- **Where:** `apps/dashboard/src/components/CanvasList.tsx`
- **Behavior:** stacked mobile card — cover, then title/status/meta, then a full-width primary action, with secondary actions in an overflow menu. Hide the bulk-select checkbox unless selection mode is explicitly entered.
- **Acceptance:** on a narrow viewport the title and status are always visible and not truncated by crowded buttons; the primary action is full-width and obvious; bulk checkbox is absent until selection mode is on; all icon-only actions have accessible names.

### 6. Lifecycle-dominant detail header
- **Where:** `apps/dashboard/src/routes/canvas.tsx` (detail chrome), `routes/canvas.overview.tsx`
- **Behavior:** for drafts (`currentVersionId === null` / `publicationState !== "published"`), reframe the header around "Draft — not live yet" with primary actions **Open draft** and **Publish**; de-emphasize the public URL and external-open until the canvas is actually reachable. Published canvases keep current emphasis.
- **Acceptance:** an unpublished canvas's header never presents the public URL as if it were live; the two primary actions are Open draft + Publish; published canvases are visually unchanged.

### 7. Guided share dependency flow
- **Where:** `apps/dashboard/src/routes/canvas.share.tsx`
- **Behavior:** when not published, replace the repeated "Publish first" notices + disabled rungs with a **single locked panel** that explains the blocker once and shows the Publish / Open-draft CTA. Reveal the full access ladder only when published.
- **Acceptance:** an unpublished canvas's Share tab shows one clear blocker explanation (not multiple), with a working CTA; once published the access ladder, people, locks, and gallery sections appear as today; the existing `shareBlocker`/`listBlocker` rules are preserved.

### 8. Consequence-tiered settings (visual only)
- **Where:** `apps/dashboard/src/routes/canvas.settings.tsx`
- **Behavior:** re-tier the rows visually into routine (SPA routing) / visibility-changing (slug, preview mode) / credential (regenerate deploy key) / destructive (archive, delete), giving risky rows clearer affordance and consequence copy. **No change to the existing `ConfirmDialog` flow.**
- **Acceptance:** tiers are visually distinct; destructive/credential rows read as higher-consequence; every existing confirmation still fires exactly as before (same dialog states: slug / key / archive / unpublish / delete).

### 9. Source-first create flow
- **Where:** `apps/dashboard/src/routes/new.tsx`
- **Behavior:** reorder to **source → name/slug → optional backend features → create/publish**. Keep "Use the API" as a distinct agent/script path with its key + curl snippet surfaced earlier. Move the `backendEnabled` toggle after source + naming so it reads as optional.
- **Acceptance:** the backend toggle no longer precedes source choice; slug validation/availability still gates submit; the API path still returns the one-time key + working curl snippet; all four methods (paste / folder / zip / api) still function.

### 10. Operational admin overview
- **Where:** `apps/dashboard/src/routes/admin.tsx`, `routes/admin.canvases.tsx`, `AdminOverview` in `lib/api.ts` + server overview query.
- **Behavior:** add a "Needs attention" lane assembled from derivable signals, each linking to its admin canvases table row/filter:
  - public-link count (new small aggregate: canvases with `access = public_link`)
  - disabled / deleted counts (existing `canvasCountByStatus`)
  - purge backlog age (existing `oldestDeletedAt`)
  - top AI spenders (existing per-canvas AI usage)
  - top-usage canvases (existing `topCanvases`)
  - admin **Featured** toggle action on the canvases table (#4's curation control)
- **Acceptance:** each attention item links to the corresponding filtered admin table view; the public-link count matches a manual count; the Featured toggle flips `galleryFeatured` and is admin-only; no trend-delta or screenshot-failure UI is shown (out of scope).

### 11. Unified, first-class canvas tags
- **Where:** new shared `apps/dashboard/src/components/Tag.tsx` + `TagFilter.tsx`; consumed in `routes/index.tsx` (owner list), `routes/gallery.tsx`, canvas detail tag editor; server owner-list + gallery queries; MCP `update_canvas`; docs (`/docs`, `llms.txt`, developer/marketing docs as applicable).
- **Behavior:**
  - A canvas carries **one tag set** (the existing `galleryTags`, surfaced as `tags`). The same tags drive personal owner-list filtering AND public gallery display when the canvas is listed.
  - **Consistent visual everywhere** — a single `Tag` pill component used in owner list, gallery, and detail; tags always look and behave the same.
  - **One space-optimal `TagFilter` control** reused in the owner-list controls and the gallery: a compact multi-select popover/combobox (search + checkable tags) plus active tags rendered as removable chips. Does not bloat the filter bar.
  - **Filtering** is URL-driven and shareable (`?tag=`, multi-value), matching the existing filter pattern; gallery's current `?tag=` single-tag behavior is folded into this.
  - **Editing** — tags become a first-class canvas property editable from the canvas detail (a dedicated tags editor), with copy clarifying they appear publicly in the gallery once the canvas is listed. The Share/Gallery tag input is replaced by / points to this unified editor.
- **Backend / MCP / docs:** reuse the `galleryTags` column (expose as `tags` in API/types — no destructive migration); add tag-filter support to the **owner** canvas-list query (gallery already supports it); ensure `update_canvas` reads/writes tags (extend if it doesn't) — owner-facing, so **MCP parity is required**; update docs to describe canvas tags + filtering.
- **Acceptance:** the same `Tag`/`TagFilter` components render identically in owner list and gallery; filtering by one or more tags works in both and is URL-shareable; editing a canvas's tags updates both surfaces; `update_canvas` can set tags over MCP with the same owner check; docs reflect the capability.
- **Security:** tags follow the canvas's existing visibility — a private/unlisted canvas's tags are never shown publicly; listing a canvas surfaces its tags in the (internal) gallery, which the owner controls by choosing to list.

### 12. Default gallery view with persisted preference
- **Where:** `apps/dashboard/src/routes/index.tsx` (view-mode resolution + SegmentedControl).
- **Behavior:** the owner canvas list defaults to **gallery/grid**. An explicit switch to list view writes the preference to `localStorage` (per-device, applies to the owner list view). A `?view=grid|list` URL param overrides for that visit (shareable/deep-linkable). Resolution precedence: **URL param > localStorage > default (grid)**.
- **Acceptance:** first visit with no stored preference and no URL param shows grid; toggling to list and reloading (no URL param) stays in list; a `?view=` link wins over the stored preference; the persisted value is read on mount without a flash of the wrong layout.

### 13. Smarter, forgiving search
- **Where:** shared server-side search in the canvas-list + gallery service queries (`apps/server`), driving the existing `?q=` in `routes/index.tsx` + `routes/gallery.tsx`; the same service is what MCP `list_canvases` calls.
- **Behavior:**
  - Match across **title, description (`gallerySummary`), tags, and slug**.
  - **Forgiving:** lowercase + trim + strip accents/diacritics; substring match (matches anywhere in a field); multi-word query splits into tokens, each token must match *somewhere* across the fields (AND, order-independent).
  - **Portable / lockstep:** matching is identical on SQLite and Postgres — no dialect-specific full-text or trigram engines.
  - Applies consistently to the owner list **and** the gallery.
- **Implementation (recommended):** maintain an additive **normalized search column** (e.g. `searchText`) = `normalize(title + " " + summary + " " + tags.join(" ") + " " + slug)`, computed in the **service layer** on every canvas write (so normalization logic lives in one place, app-side, not in SQL). Query = `normalize(q)` split into tokens, each `LIKE '%token%'` against `searchText`, AND-ed. Additive migration + a one-time backfill of existing rows (backward-compatible, non-destructive).
- **Acceptance:** searching a substring of a title, summary, tag, or slug finds the canvas; queries differing only in case, surrounding spaces, or accents still match; a two-word query matches a canvas where the words live in different fields; results are identical across both dialects (covered by the dual-dialect test leg); pagination still works (matching is server-side over the whole set).
- **Parity / docs:** not a new capability — the same shared service powers MCP `list_canvases`, so its `q` filter inherits the improvement automatically (no new MCP tool). Update docs only if search behavior is documented.

## Data & backend additions (consolidated)

All additive; both dialects kept in lockstep with a generated migration (`drizzle/pg/*` + `drizzle/sqlite/*`).

- **`Canvas.galleryFeatured: boolean`** (default false) — admin-set; drives #4 Featured row + #10 admin toggle.
- **`GalleryItem.recentViews`** — expose the already-computed trending value on gallery items (read-only) for the Trending sort/row.
- **Gallery list sort param** — Featured / Trending / Recent / Title (server-side, URL-driven).
- **`AdminOverview.publicLinkCount`** — new aggregate count.
- **Admin route** to set `galleryFeatured` (admin-only, audited like other admin actions).
- **Tags (#11):** reuse the existing `galleryTags` column, exposed as `tags` in API/types (no destructive migration). Add `?tag=` (multi-value) filtering to the **owner** canvas-list query (gallery already supports tag filtering).
- **View pref (#12):** client-only — `localStorage` + `?view=` resolution. No backend.
- **Search (#13):** additive normalized `searchText` column on the canvas, maintained in the service layer on write, with a non-destructive backfill migration (both dialects). Powers owner-list + gallery + MCP `list_canvases` search.

## Agent-native parity

- **#11 tags are owner-facing → MCP parity required.** Tags flow through the existing `update_canvas` service wrapper; confirm it reads/writes the unified `tags` and extend it if needed (same `requireOwned` owner check). Update the docs surfaces (`/docs`, `llms.txt`, developer + marketing docs) to describe canvas tags and filtering.
- Items 1–3, 5–10, 12 add no new owner-facing capability — they are presentation/IA over existing data, or (for #4 featured) an **admin-curated** action that by rule lives on admin routes and is exempt from per-account MCP parity (same as public-link gating).
- No other new MCP tools are required; existing owner capabilities (preview mode/custom cover, sharing, gallery listing) keep their current parity and contract.

## Security & invariants

- Covers never expose content the viewer lacks access to: fallback shows metadata only; screenshot URL stays access-gated.
- Featured is admin-only and filtered to listed+published; unlisting/unpublishing removes a canvas from the featured row.
- No change to identity, auth context, access rungs, or the publish/draft model — this sweep is presentation + small read-side additions.

## Scope boundaries (out)

- Screenshot-capture pipeline work (Chromium/infra) — covers stay fallback-only.
- AI-spend trend history / week-over-week deltas (would need a snapshot table + capture job).
- Screenshot-failure tracking and audit-log aggregation in admin.
- Owner self-featuring and any featured ranking/cap logic (admin-curated only).
- Backend behavior changes beyond the additive fields/aggregates listed above.

## Dependencies & assumptions

- Preserve the React + Tailwind v4 stack, the `tokens.css` semantic variables, Phosphor icons, shared components (Button/Badge/EmptyState/Panel/Section/Field), and the editorial direction.
- **Assumption (confirm in plan):** sparse trigger = ≤ 3 active canvases or a draft as the most recent canvas.
- **Assumption:** "type" embedded in content-aware covers maps to existing concept badges (canvas / template / listed / protected).
- Server-side filters/sort already follow a URL-driven, shareable pattern; new sort/featured params follow it.

## Outstanding questions

- Exact sparse threshold and whether the strip should cycle through multiple unfinished canvases or surface just one (default: one, the most recently touched draft).
- Featured row size/overflow behavior when many canvases are featured (default: cap the row, link "see all featured" into a filtered gallery view).

## Test plan

- **Desktop visual regression:** sparse owner list (with/without strip), rich gallery (featured/recent/tag rows + sort), create flow reorder, canvas overview/share/settings/editor, admin overview + canvases table.
- **Mobile visual regression:** owner list card (stacked), gallery card feed, detail header tabs.
- **Empty states:** no canvases, no archived, no search results, no gallery results, failed load — each shows the correct single action; "Clear search" preserves other filters.
- **State correctness:** unpublished canvas never implies a live public URL (header + share); published restores share/gallery affordances; featured canvas that unlists/unpublishes drops from the featured row.
- **Backend:** dual-dialect schema-parity + migration tests for `galleryFeatured`; admin featured toggle is admin-only and audited; `publicLinkCount` matches a manual count; gallery sort returns correct ordering on both dialects; owner-list `?tag=` filtering returns correct results on both dialects.
- **Tags (#11):** `Tag`/`TagFilter` render identically in owner list + gallery; single- and multi-tag filtering works and is URL-shareable in both; editing tags updates both surfaces; `update_canvas` sets tags over MCP under the same owner check; a private/unlisted canvas's tags are not shown publicly.
- **View pref (#12):** no preference + no param → grid; toggle to list persists across reload; `?view=` overrides stored preference; no flash of wrong layout on mount.
- **Search (#13):** substring matches in title / summary / tag / slug each find the canvas; case-, space-, and accent-only differences still match; a two-word query matches when the words span different fields; `searchText` backfill + write-maintenance verified; identical results on both dialects; MCP `list_canvases` `q` inherits the behavior.
- **Accessibility:** keyboard focus order across new strip/panels, icon-button names, mobile overflow menus.
- **Seeded smoke:** `pnpm seed:usage`, verify admin overview attention lane + top canvases + AI usage render.

## Handoff

Next: `/ce-plan` against this doc to produce the unit breakdown for the single sweep PR (group by surface, dependency-ordered: schema/migration + gallery/admin data first, then the presentation units). Then build end-to-end per the autonomous-round workflow, `/ce-code-review` before the PR, fix findings, green CI, merge.
