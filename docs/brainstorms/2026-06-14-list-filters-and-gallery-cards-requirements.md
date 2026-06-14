---
date: 2026-06-14
topic: list-filters-and-gallery-cards
---

# List filters, inline attribute pills & beautiful gallery cards

## Summary

Add per-surface filter and sort controls to the two list views a member
actually browses — the **gallery** and **Your canvases** — surface every
filterable attribute as an inline pill/symbol on each item so a list reads at
a glance, and give gallery cards a beautiful generative cover (deterministic
per-canvas art now, real screenshot previews as a later upgrade).

## Problem Frame

The gallery today offers free-text search and a single-tag filter; **Your
canvases** offers nothing — no search, no filter, no sort. As a person
accumulates canvases, or as the gallery fills with colleagues' work, both
lists become a flat scroll with no way to narrow to "my templates," "the
interactive ones," or "what I started but never shipped." The attributes that
*would* let someone navigate (tags, owner, access state, deployment state) are
either invisible or shown inconsistently.

Separately, the gallery card is a plain bordered surface — functional but
flat. Canvases are visual web artifacts; a gallery of them should look like
one. There's no per-canvas imagery anywhere in the product today, so the card
has nothing to make one canvas feel distinct from the next.

## Key Decisions

- **Filters are tuned per surface, not one shared control.** The gallery
  visibility predicate (`apps/server/src/db/repositories/canvases.ts:112`)
  guarantees every listed canvas is active, shared, unprotected, listed, and
  published — so shared/protected/listed are *constants* in the gallery and
  only earn filters on Your canvases, where the full range of states varies.

- **Pills mirror filters.** The inline attributes shown on each item are the
  same set you can filter on. This keeps the list coherent — what you filtered
  by is visible on the results — and avoids inventing a second, divergent
  vocabulary of badges.

- **Filter/sort state lives in the URL** (search params), as the gallery
  already does for `q`/`tag`/`page`. Views stay shareable and
  back-button-able; Your canvases adopts the same convention.

- **Generative cover now, real screenshots later.** Gallery cards get a
  deterministic generative cover derived from the canvas's identity (never
  blank, beautiful immediately, same canvas always renders the same art). A
  real headless-capture screenshot pipeline is a separate, later upgrade that
  layers on top where a capture exists — it does not block this work.

## Requirements

### Gallery — filtering & sort

- R1. The gallery supports filtering by **tag**, by **owner/author**, and by
  **templatable** (cloneable). Tag filtering already exists for a single tag;
  owner and templatable are new. (Terminology: `templatable` names the
  filterable attribute; the inline badge reads **Template** — this filter-vs-badge
  split is the existing convention in `CanvasList`/gallery, kept deliberately.)
- R2. The gallery offers a **sort** control. Default is newest-published
  (the current fixed order); at minimum one alternative axis (e.g. recently
  updated or title A–Z) is available. (See Outstanding Questions if sort is
  dropped.)
- R3. Filters compose: selecting a tag, an owner, and templatable narrows to
  the intersection. Active filters are individually clearable, plus a
  clear-all affordance (extending the existing tag-chip clear pattern).
- R4. All gallery filter and sort state is encoded in the route's search
  params so a filtered view is shareable and survives back-navigation.

### Your canvases — filtering & sort

- R5. Your canvases supports filtering by **access & gallery state** — shared,
  password-protected, listed, template.
- R6. Your canvases supports filtering by **deployment state**. The canonical
  states are: **never-deployed** (no published version), **has-unpublished-changes**
  (a draft differs from the live version — "started but not shipped"), and
  **clean** (deployed, no pending draft). The filter offers never-deployed and
  has-unpublished-changes as selectable values; clean is the implicit default
  (everything not matching the other two), not a selectable chip.
- R7. Your canvases offers a **search** box and a **sort** control (default
  recently-updated/-deployed). Search and sort are new to this surface.
- R8. Filter/sort/search state lives in the URL search params, matching the
  gallery convention (R4).

### Inline attribute pills & symbols

- R9. Each item in both lists shows its meaningful attributes inline as
  pills/symbols, drawn from the same attribute set that surface can filter on
  (Key Decision: pills mirror filters). The gallery card shows tags, the
  **Template** badge, and owner. Your-canvas rows show a badge for each *active*
  access/gallery state from R5 — **Shared**, **Protected**, **Listed**,
  **Template** (matching the existing `RowBadges` set) — plus the new
  deployment-state indicator (R10). The filter→pill mapping is 1:1: every R5/R6
  filter value has a corresponding badge, and only that set is badged.
- R10. A new **deployment-state** indicator appears on Your-canvas rows for the
  two notable states from R6: **never-deployed** and **has-unpublished-changes**
  are each visually distinct. The **clean** state gets no pill — it is the quiet
  default, consistent with the existing `RowBadges` "only badge what's notable"
  rule.

### Beautiful gallery card

The generative cover is a **visual-identity** layer — its job is "never blank,
distinct per canvas, looks like a gallery of artifacts," *not* "preview what the
canvas does." Only the deferred real screenshot (R13) advances content
discovery; R11–R12 deliberately buy identity and polish, not evaluation.

- R11. Every gallery card renders a **generative cover** as its visual —
  deterministic from the canvas's stable identity, so the same canvas always
  produces the same art and no card is ever blank. Scope bound: a lightweight
  seeded approach (e.g. gradient/mesh from a hashed seed), no heavy runtime
  dependency and a small client-bundle delta — not a bespoke WebGL/compositing
  system.
- R12. The card is visually elevated beyond today's flat bordered surface
  (e.g. the cover as a hero region, a hover lift/affordance), while preserving
  the existing affordances: title-as-open-link, summary, tag pills, owner,
  Make-a-copy, and Copy-link.
- R13. The generative cover is the baseline; a real screenshot preview, when
  one exists for a canvas, supersedes the generative art in the same card
  region. (The capture pipeline itself is out of scope here — see Scope
  Boundaries — but the card's design must accommodate the later swap without
  rework; see the card-design constraints under Deferred to planning.)

## Acceptance Examples

- AE1. **Covers R1, R3.** In the gallery, a member selects owner = "Dana" and
  templatable = on. The grid shows only Dana's cloneable listed canvases.
  Removing the templatable filter widens to all of Dana's listed canvases;
  clear-all returns to the full gallery.
- AE2. **Covers R5, R6, R9.** On Your canvases, a member filters to "shared"
  and "has unpublished changes." Each matching row shows a Shared badge and a
  draft/unpublished indicator inline, so the filter result is self-evidently
  correct without opening any canvas.
- AE3. **Covers R6, R10.** A canvas the member created but never deployed
  appears under the never-deployed filter and carries a never-deployed
  indicator; a deployed canvas with no pending draft carries neither
  deployment pill (clean is the quiet default).
- AE4. **Covers R11, R13.** A newly listed canvas with no screenshot renders a
  generative cover immediately. Later, once a screenshot exists, the same card
  shows the screenshot in the same region with no layout change.

## Scope Boundaries

### Deferred for later

- The **real screenshot / headless-capture pipeline** (capture on publish,
  storage, staleness/refresh, sandboxing untrusted canvas content). The card
  is designed to accept it (R13), but building it is a separate effort.
- **Backend/interactivity as a filter** on either surface. The user passed on
  it for now; the underlying data work could expose it later if wanted.
- **Multi-tag (OR) selection** in the gallery beyond today's single tag — a
  natural enhancement, but not required for v1 of this work.

### Outside this scope

- **Archived** and **Admin** list views — left as-is. (Admin already has its
  own status-tab filter.)
- **Live `<iframe>` embeds** as card previews — rejected (perf + security at
  gallery scale).
- **Owner-uploaded cover images** — rejected (optional → mostly blank →
  inconsistent; pushes work onto owners).

## Dependencies / Assumptions

- **Owner & tag filters need a facet source — and owner/templatable need
  where-clause predicates too.** Today the gallery query accepts only `q`/`tag`;
  owner and templatable need both new query params + `where` predicates in
  `listGallery` *and* a facet source (a *pickable list* of owners/tags). Two
  constraints on the facet/owner work: (a) **field restriction** — the owner
  facet must expose only the fields the gallery DTO already allows (display name
  + avatar), never owner email or internal ids (§12.0 #1); (b) it must sit behind
  the same session gateway as the gallery. See Outstanding Questions for the
  owner-identity (stable key) decision this forces.
- **Filter/sort params AND onto the visibility predicate (cross-cutting
  invariant).** Every gallery filter/sort param is an *additional* AND on top of
  `galleryVisibilityFilters` (active, shared, unprotected, listed, published);
  no param may modify or override those five constants, and a missing/malformed
  param still returns only visible canvases. This is a testable invariant, not
  only the prose guarantee in Key Decisions.
- **Deployment-state filter: `never-deployed` is cheap, `has-unpublished-changes`
  is not.** `never-deployed` is derivable from the existing payload
  (`lastDeploy === null` / `currentVersionId IS NULL`). But
  `has-unpublished-changes` (dirty) is **not a stored column** — only `stale` is.
  Dirty is computed by loading the draft manifest *and* the live-version manifest
  and diffing every path's content hash (`isDirty` in `draft-api.ts`). For a list
  of N canvases that is N draft + N version-manifest fetches + N diffs, i.e. a
  batched fetch + per-row computation (mirroring the batched version lookup in
  `management.ts`), **not a column join**. Planning should size this as data-layer
  work, not a `LEFT JOIN`.
- **Generative cover needs a stable per-canvas seed.** Assumed to derive from
  an existing immutable identifier (slug or id); no new field required.
- The gallery's existing URL-state pattern (`q`/`tag`/`page` in search params)
  is the model both surfaces follow; assumed extensible to the new params.

## Outstanding Questions

### Resolve before planning

- **Owner-filter identity key.** Filtering/labelling by owner needs a *stable*
  key, but the gallery deliberately ships only owner name + avatar (no id/email).
  A display name is not stable (collisions, renames). Decide: expose an opaque,
  non-PII owner key/handle in the gallery payload + facet (confirm that exposure
  is acceptable), or accept name-match filtering with its ambiguity. This gates
  the owner-filter design.

### Deferred to planning

- **Sort control inclusion.** A light sort ships alongside filters (R2, R7) on
  the assumption it's wanted; if not, sort stays fixed and R2/R7's sort clause
  drops. Confirm during planning if there's any doubt.
- **Filter control shape per surface** (segmented chips vs dropdowns vs a
  faceted bar), *and* whether the gallery (cards) and Your-canvases (rows)
  surfaces share one control pattern or may diverge. In-repo precedent: the admin
  status-tabs (`apps/dashboard/src/routes/admin.tsx`) and the gallery search +
  tag-chip (`apps/dashboard/src/routes/gallery.tsx`).
- **Generative cover style** (gradient / mesh / pattern; palette derivation),
  within the R11 scope bound. Prior art: GitHub identicons, Vercel OG gradients,
  Linear's gradient identity art.
- **Card-design constraints (load-bearing — name before building the cover).**
  (a) Cover region is a **fixed aspect-ratio box**; the later real screenshot is
  object-fit cropped into it so the R13 swap is genuinely "no layout change".
  (b) **Contrast-safe text zone** + alt-text policy for title/labels over the
  generative art (palette is free but must clear WCAG contrast). (c) The
  **cover-vs-content stacking** decision for R12's six elements + hero.
- **Filter/pill interaction states (enumerate so none is missed).** Zero-result
  empty state for a composed filter set vs the "no canvases at all" state, per
  surface (the gallery has both today — preserve them); the no-active-filter
  default on Your-canvases; active-filter chip rendering/order and individual vs
  clear-all clearing; the **pill-vs-symbol** rule (when labelled pill vs icon);
  tag + badge **overflow** policy on dense rows; mobile/responsive layout of the
  new controls.

### From the 2026-06-14 doc review (deferred for your decision)

- **Right-size the Your-canvases filter set (R5–R6).** The six axes are
  motivated by anticipated volume, not present pain, on a solo owner's list that
  may hold few rows. Decide whether to ship the always-useful pieces now
  (deployment-state pill R10 + default sort R7) and defer the rarer access-state
  filters (shared/protected/listed/template) until a list is actually long — or
  keep the full set. *(scope-guardian + product-lens)*
- **Owner/tag facet: endpoint vs inline query.** A general facet-enumeration API
  has one current consumer (the filter UI); a `GROUP BY` inline in the existing
  gallery query may suffice. Promote to a dedicated endpoint only if a second
  call site emerges. *(scope-guardian)*

## Sources / Research

- Gallery view + card: `apps/dashboard/src/routes/gallery.tsx`; gallery API
  `apps/server/src/routes/gallery.ts`; visibility predicate + list query
  `apps/server/src/db/repositories/canvases.ts:112` and `:435`.
- Your canvases + rows: `apps/dashboard/src/routes/index.tsx`,
  `apps/dashboard/src/components/CanvasList.tsx` (existing `RowBadges`).
- Admin status-filter precedent: `apps/dashboard/src/routes/admin.tsx`.
- Data shapes: `apps/dashboard/src/lib/api.ts` (`Canvas`, `CanvasListItem`,
  `GalleryItem`, `DraftView`).
- Card-imagery prior art reviewed: live screenshot thumbnails
  (Dribbble/Behance, CodePen), live iframe previews (CodePen/Glitch),
  deterministic generative covers (GitHub identicons, Vercel OG, Linear).
