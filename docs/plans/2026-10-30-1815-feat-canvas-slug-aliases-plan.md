---
title: "feat: Canvas slug aliases"
type: feat
status: active
date: 2026-10-30
---

# feat: Canvas slug aliases

## Summary

A canvas keeps exactly one **canonical slug** (`canvases.slug`) that serves its content,
and may additionally carry up to **10 aliases**. Opening an alias URL redirects (`302`) to
the canonical URL, preserving the remaining path and query string. Renaming a canvas can
keep the old slug as an alias so shared links keep working, and an alias can be promoted
to canonical. Decided with Mark on 2026-10-30: both "several names" and "links survive a
rename" matter; redirect (not serve-in-place); cap of 10.

This extends the custom-slugs plan (`2026-06-16-004-feat-custom-slugs-plan.md`), which
listed "old-slug redirects" as out of scope.

## Key technical decisions

- **KTD1 — Redirect, never serve at an alias.** The slug is an origin in subdomain mode
  (§12.0 #4 cross-canvas isolation checks `Origin` against the slug), the SDK derives its
  slug from `location`, and browser storage / the password-gate cookie are per slug.
  Redirecting keeps exactly one origin per canvas, so only the canvas-content entry point
  (`canvasAccess`), the public-link carve-out and the unfurl card know aliases exist. The
  runtime API (`/v1/c/:slug`), realtime and deploy paths accept canonical slugs only.
- **KTD2 — Same access decision before the redirect.** An alias hit runs
  `decideAccessFor` against the target canvas with the request's principal. Allow →
  `302` to the canonical URL (`Cache-Control: no-store`). Deny → exactly the response the
  canonical URL would give (404 / disabled page), so an alias never reveals the canonical
  slug of a canvas the viewer can't open. A password gate runs on the canonical URL.
- **KTD3 — `302`, not `301`.** Aliases are mutable; browsers cache `301` indefinitely.
- **KTD4 — Table `canvas_slug_aliases(id, slug unique, canvas_id → canvases, created_by,
  created_at)`**, additive migration on both dialects, no backfill. `canvases.slug`
  stays the canonical slug so no existing reader changes.
- **KTD5 — One namespace.** `slugTaken` is the single availability predicate and now
  checks both tables (status-unaware, like the unique index), so slug-available, create,
  clone, rename and alias-add all agree. The two unique indexes close same-table races;
  the cross-table race (an alias and a canonical slug claimed in the same instant) is
  benign because canonical lookup always wins, and is re-checked after the alias insert.
- **KTD6 — Lifecycle follows the canvas.** Aliases stay reserved while the canvas is
  archived, unpublished, disabled or soft-deleted (as the slug itself is), and are only
  served for non-deleted canvases. The purge sweep releases them (the canonical slug stays
  on the tombstone). Clone does not copy aliases; transfer keeps them.
- **KTD7 — Rename keeps the old slug on request.** `regenerate-slug` / `set_canvas_slug`
  accept `keepOldAsAlias` (API default `false`, so existing callers keep today's
  semantics). The dashboard defaults the checkbox **on** for a custom rename and **off**
  for a random regenerate (that is the "the URL leaked, rotate it" path). Renaming to one
  of the canvas's own aliases **promotes** it (the alias row is removed, the old
  canonical optionally becomes an alias). A rename drops live sockets as before.
- **KTD8 — Role.** Managing aliases is the same role as renaming (`editor`), declared in
  `tool-roles.ts`. Every add/remove is audited (`slug_alias_add` / `slug_alias_remove`).

## Units

1. Schema + migrations (pg + sqlite), backup table order + FK-edge test.
2. Repository: `listAliases`, `addAlias`, `removeAlias`, `findByAlias`; `slugTaken` covers
   aliases; `regenerateSlug` handles keep-old + promote in one transaction.
3. Service `canvas/slug-aliases.ts`: `renameCanvasSlug`, `addCanvasAlias`,
   `removeCanvasAlias` shared by HTTP and MCP (validation, cap, audit, socket drop).
4. Alias redirect in `canvasAccess`; alias fallback in the public-link carve-out (canvas
   role only) and the social-preview unfurl.
5. Management routes: `GET/POST /api/canvases/:id/aliases`, `DELETE …/aliases/:slug`,
   `regenerate-slug` gains `keepOldAsAlias`.
6. MCP: `add_canvas_alias`, `remove_canvas_alias`; `set_canvas_slug` gains
   `keepOldAsAlias`; `get_canvas` returns `aliases`.
7. Dashboard: "Also reachable at" list in Settings → URL & routing (add / copy / remove /
   make primary); rename dialog checkbox.
8. Docs (site + generated), tests on both dialects.

## Test scenarios

- Alias → `302` to canonical, path + query preserved, both URL modes.
- Alias of a canvas the viewer can't open → same 404 as the canonical URL; disabled →
  disabled page; deleted canvas → 404.
- Public-link canvas alias works for an anonymous visitor.
- `/v1/c/{alias}/…` does not resolve.
- Alias add: invalid / reserved / taken by a canvas / taken by an alias / own canonical /
  over the cap → rejected; viewer role → not found.
- Rename with keep-old: old slug redirects; without: old slug 404s; promote swaps.
- Slug availability and create with a custom slug reject a name held as an alias.
- MCP parity: tools registered with role entries; behaviour matches HTTP.

## Out of scope

- Including aliases in the canvas search blob.
- A cooldown before a removed alias can be claimed by someone else.
