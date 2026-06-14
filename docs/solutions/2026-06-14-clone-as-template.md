---
title: Clone a canvas as a template — copy mechanics, listability tightening, and where the agent surface lives
type: architecture
area: canvas
date: 2026-06-14
---

Plan 002 added "Make a copy / Use as a template": a member creates a new canvas they
own from an existing one. This note records the load-bearing decisions so future work
on cloning, the gallery, or storage builds on them. Builds on
[[2026-06-13-content-addressed-draft-publish]], [[2026-06-13-gallery-listing-patterns]],
and [[2026-06-13-auth-invariant-checklist]].

## Cloning is a manifest copy + a per-canvas blob copy — nothing clever

Files are content-addressed per canvas (`canvases/{id}/blobs/{sha256}`, manifest =
`path → {size, hash, mime}`). A clone therefore:

1. picks the **seeding manifest** — the source's published version manifest, falling
   back to its draft only when never published (own-canvas case);
2. creates a new canvas (new id/slug/API key, `owner = caller`);
3. copies each **distinct hash** in the manifest into the clone's blob namespace via
   the new `StorageDriver.copy` (S3 `CopyObject` server-side, local `copyFile`, mem
   buffer copy) — dedup by hash, so two paths sharing content copy one blob;
4. seeds the clone's **draft** with that same manifest, verbatim (identical bytes →
   identical hash → no reference rewriting).

Blobs are deliberately **per-canvas, not global** (see the content-addressed note), so
the clone gets its own copies — deleting/purging the source never breaks the clone.
Seed the draft **after** all blobs land, so a mid-copy failure can't leave a draft
pointing at an absent blob (a missing blob already surfaces as an explicit editor
error, not a blank).

## Reset vs. carried (the security-relevant part)

A clone is a fresh canvas, not a shallow link. Carried: the files, `description`, the
title as `"Copy of <title>"`, the source's **password** (`passwordHash` +
`passwordVersion` — the gate grant is HMAC'd per-canvas, so a copied hash is safe and
the cloner re-enters the password on the new canvas), and lineage
(`clonedFromCanvasId`). Reset regardless of source state: owner, slug, API key, version
history (starts unpublished, `currentVersionId = null`), and **all sharing/gallery
state** (`shared`/`galleryListed`/`galleryTemplatable` forced false, gallery metadata
nulled) — "not shared no matter original status". Runtime primitive data (KV, files,
usage) is **not** copied: a template is static content, not another canvas's data.
`backendEnabled` is reset off (static-first); the cloner re-enables if needed.

## Gallery listability was tightened (and an M8 decision reversed)

Listing now requires **active + shared + published + no password** (was: any
shared+listed canvas, password allowed). Enforced in two mirrored places:

- **Write guard** (settings route): rejects listing an unpublished/protected canvas
  (409 with a typed reason the dashboard shows inline), and setting a password
  auto-unlists + clears templatable + gallery metadata. The dashboard warns before the
  password-driven unlist.
- **Read predicate**: `galleryVisibilityFilters` (one shared builder) gained
  `password_hash IS NULL`. It's reused by `listGallery` AND `findCloneableTemplate`
  (the non-owner clone-eligibility check) so the two can't drift — a canvas the gallery
  wouldn't show is not cloneable by a non-owner.

`galleryTemplatable ⊆ galleryListed` is an invariant: every write that clears
`galleryListed` also clears `galleryTemplatable` (repo `updateSettings` + the password
unlist). Two new nullable/boolean columns (`gallery_templatable`,
`cloned_from_canvas_id`) added via migration 0009, both dialects in lockstep.

## Authorization: own-active OR gallery-templatable, opaque-404 otherwise

`POST /api/canvases/:id/clone`: an owner may clone any **active** canvas they own; a
non-owner only one that is gallery-eligible **and** templatable (via
`findCloneableTemplate`, same predicate as the gallery). A non-eligible source 404s
**opaquely** (§12.2) so its existence isn't revealed. Eligibility is always re-derived
server-side from the row, never from client input.

## The clone surface is the HTTP endpoint, NOT the runtime SDK

`@canvas-drop/sdk` is the **canvas-runtime** SDK (KV/files/`me()`, scoped to one canvas
via `/v1/c/{slug}`, called from inside a deployed canvas). Cloning is a
**session-authenticated member action** that mints a *new user-owned* canvas — a canvas
API key can't do that. So there is intentionally **no `clone()` on the runtime SDK**;
agent-native parity is satisfied by the dashboard endpoint
(`POST /api/canvases/:id/clone`), which is the agent surface. Don't "fix" this by adding
clone to the runtime SDK — it would have the wrong auth context and base path.
