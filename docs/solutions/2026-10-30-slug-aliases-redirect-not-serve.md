---
title: Slug aliases — redirect to one canonical slug, never serve at two
date: 2026-10-30
category: architecture
---

# Slug aliases — redirect to one canonical slug, never serve at two

Plan: `docs/plans/2026-10-30-1815-feat-canvas-slug-aliases-plan.md`. Builds on
[[2026-06-17-dialect-unique-violation-catch]].

## The trap

"Let a canvas answer to several names" looks like a lookup change: resolve the alias to the
canvas and serve it. It isn't, because the slug is more than a name:

- In subdomain mode the slug **is the origin**. `canvas-api-isolation.ts` requires the
  `Origin` of every `/v1/c/:slug/*` call to match the slug in the path (§12.0 #4).
- The SDK derives its slug from `location`, so a page served at an alias would call the
  runtime API under the alias.
- localStorage, cookies and the password-gate cookie (path-scoped in path mode) are per
  slug, so one visitor would look like two.

## The shape that works

- One canonical slug (`canvases.slug`) serves content. Aliases live in
  `canvas_slug_aliases` and only ever produce a `302` (never `301`: aliases are mutable)
  to the canonical URL with the rest of the path and query.
- The alias hop runs the **same** `decideAccessFor` decision first. Deny gives exactly the
  canonical URL's response, so an alias can't reveal the canonical slug of a canvas the
  viewer can't open.
- Only three places learn about aliases: `canvasAccess` (the redirect), the public-link
  carve-out (canvas role only, so an anonymous visitor reaches the redirect), and the
  unfurl card. `platform-api`, realtime and deploy stay canonical-only.

## Two unique indexes, one namespace

`canvases_slug_uq` can't see the alias table. Keep **one** availability predicate
(`slugTaken`, which checks both tables) and route every claim through it, including
`resolveCreateSlug`'s custom branch, which now pre-checks instead of relying on the
canonical index alone. The residual cross-table race is benign (canonical lookup wins),
and alias-add re-checks the canonical table after insert and gives the name back.
