---
title: Shared discovery listability — access is not discoverability
type: architecture
area: auth
date: 2026-06-24
---

Read this before touching Shared, gallery, Team sharing, or any cross-owner list
surface. This builds on [[2026-06-13-gallery-listing-patterns]],
[[2026-06-21-teams-parity-shared-helpers-and-listforuser]], and
[[2026-06-13-auth-invariant-checklist]].

## Access and discovery are separate controls

The access rung answers "can this viewer open the URL?" `discoverability` answers
"should this canvas be listed for viewers who can already open it?"

- `specific_people` grants appear in each granted user's **Shared** view
  automatically. The grant itself is the discovery signal.
- `team` and `whole_org` are URL-only by default:
  `discoverability='link_only'`.
- `team` and `whole_org` appear in **Shared** only when the owner chooses
  `discoverability='listed'`.
- `public_link` never appears in **Shared**. Use the gallery for deliberate
  public or org-wide browsing.

Do not infer listability from `access !== 'private'`. That re-creates the
automatic directory the product intentionally avoids.

## Shared and gallery use different list predicates

**Shared** is viewer-scoped and non-owned. Its candidate set is:

1. Active, published, unexpired direct `specific_people` grants for the viewer.
2. Active, published, unexpired `team` canvases where the viewer belongs to a
   granted team and `discoverability='listed'`.
3. Active, published, unexpired `whole_org` canvases in the viewer's org scope
   with `discoverability='listed'`.

**Gallery** is broader public/org discovery and deliberately narrower:

- `public_link` canvases can be gallery-listed when the gallery preconditions hold.
- `whole_org` canvases can be gallery-listed only when `discoverability='listed'`.
- `team`, `specific_people`, and link-only `whole_org` canvases never appear in
  the gallery.

Both surfaces must keep explicit projections and exact-key response tests. They
are cross-owner read surfaces, so never row-spread a `canvas` or `user`.

## Migration default is conservative and data-preserving

The `discoverability` migration adds a NOT NULL column with default `link_only`.
Existing deploy data keeps its current access behavior. Ordinary Team/Whole-org
shares stay URL-only, but existing Whole-org rows that were already
`gallery_listed=true` are backfilled to `discoverability='listed'` so the deploy
does not silently remove them from the gallery or clone/template eligibility.
That is the only migration exception; it preserves an existing listing opt-in.

When seed or screenshot scripts create gallery/demo content, they must set
`discoverability: 'listed'` explicitly for rows meant to appear in Shared or in
the gallery. A gallery-listed Whole-org row without `discoverability='listed'`
is intentionally hidden.

## Tests to keep paired

Changes here need coverage in both directions:

- URL access still works for link-only Team/Whole-org rows.
- Link-only rows do not appear in Shared or gallery list responses.
- Listed Team/Whole-org rows appear in Shared for allowed viewers only.
- Gallery still excludes Team and Specific-people rows even if they are listed.
- MCP `list_shared_canvases` and the dashboard `/shared` route call the same
  service so agent and UI behavior cannot drift.
