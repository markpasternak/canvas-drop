# Custom canvas slugs — requirements

**Date:** 2026-06-16
**Status:** Ready for planning
**Author:** brainstorm (Mark + agent)

## Problem & motivation

Today every canvas gets a fully random, readable-random slug (`quiet-otter-x7k2m9…`,
`apps/server/src/canvas/slug.ts`). It is unguessable by design, which `BUILD_BRIEF.md` D3
lists as defense-in-depth for the sharing access ladder — and D3 explicitly says "No custom
names in v1." v1 is complete; this is a deliberate post-v1 evolution.

The random slugs are unmemorable. Owners want human-readable URLs they choose
(`team-dashboard.canvas-drop.com`) instead of being handed a random one. The ask: let the
owner type their own slug at create time, fall back to the random generator when left empty,
validate it live, and warn if it's already taken.

## Goals

- An owner can choose a custom slug when creating a canvas, or leave it empty for today's
  random slug (unchanged default).
- An owner can change an existing canvas's slug to a custom value after creation.
- Invalid or already-taken slugs are caught with clear, inline feedback before submit.
- A custom slug works identically whether the instance runs in path mode (`/c/{slug}/`) or
  subdomain mode (`{slug}.host`).

## Non-goals

- No optional slug parameter on the MCP `create_canvas` tool or the keyed deploy API —
  agents keep receiving random slugs. (Revisit later for agent-native parity.)
- No redirect or "parking" of an old slug after a rename — old URLs 404 immediately, matching
  today's `regenerate-slug` behavior.
- No change to the random generator, its entropy, or the readable-random format.
- No reservation of slugs across orgs/instances — uniqueness is per instance, as today.

## Users & context

The actor is an **authenticated org member** creating or managing a canvas they own
(trusted-org product, not the hostile internet). Custom slugs are a convenience for that
trusted owner; the obscurity that random slugs provided is treated as defense-in-depth only,
never the sole control (`BUILD_BRIEF.md` §4.6, §12.1.4). Real protection remains auth +
password gate + guest invites + public-link gating.

## User-facing behavior

### Create form (`apps/dashboard/src/routes/new.tsx`)

- A **Slug** field appears directly below the existing **Title** field, marked optional,
  applying to all four creation methods (paste / folder / zip / api).
- Empty → server generates a random slug as today. Non-empty → the typed value is used.
- As the user types, the field **gently normalizes** input toward a valid slug (lowercase,
  spaces and runs of invalid characters collapse to a single hyphen) and shows a **live
  preview of the final canvas URL** built from the current value.
- Live validation feedback below the field:
  - Grammar violation (after normalization still invalid, e.g. empty, leading/trailing
    hyphen, too long) → inline error, submit disabled.
  - Reserved word → inline error naming it as reserved.
  - Already taken → inline **warning** ("that slug is taken — try another"), submit disabled.
  - Valid + available → subtle confirmation (e.g. the URL preview shown as available).

### Rename after creation (folds into the existing slug-rotation flow)

- The existing `POST /api/canvases/:id/regenerate-slug` flow / its UI gains a "set your own
  slug" path alongside "generate a new random one." Same DNS-safe grammar, reserved-word, and
  availability validation as the create form.
- Renaming **invalidates all old slug URLs** and **drops live realtime sockets** so clients
  reconnect under the new slug — this is already true for random regeneration today
  (`apps/server/src/routes/management.ts` slug-regen path; D-RT-6 / §12.0 #5). The rename UI
  must state this consequence clearly before confirming.

### Public + custom-slug heads-up

- When a canvas is **public AND** uses a **custom (non-random) slug**, surface an
  informational heads-up in the make-public / share flow (`apps/dashboard/src/routes/
  canvas.share.tsx`): the URL is human-guessable, so anyone who guesses it can reach a public
  canvas. This is the only place the obscurity trade-off becomes user-visible; it is
  informational, not a blocker.

## Validation rules (the slug grammar)

One **DNS-safe** grammar, enforced server-side (the authority) and mirrored client-side for
live feedback, applied to **all** slug-setting paths (create, rename):

- Allowed characters: lowercase `a–z`, digits `0–9`, and hyphen `-`.
- Length: **≥ 1** and **≤ 63** characters (DNS label limit).
- No leading or trailing hyphen; no empty result after normalization.
- Not in a **reserved-word blocklist** (system subdomains/paths) — at minimum: `www`, `api`,
  `app`, `docs`, `gallery`, `auth`, `sdk`, `admin`, and the reserved path prefixes already
  defined for the SPA (`apps/server/src/dashboard/serve-spa.ts` `RESERVED_API_PREFIXES`).
  Planning should converge this list with whatever path/subdomain reservations already exist
  so a custom slug can never shadow a system route in either URL mode.
- Uniqueness: must not collide with an existing canvas slug on this instance.

Server-side validation is authoritative; the client check is UX only. The "is it available?"
check is a lightweight server lookup the client calls (debounced) as the user types, and the
server re-validates atomically on create/rename to close the check-then-act race.

## Scope boundaries

**In scope**
- Optional slug field on the create form (all four methods).
- Custom-slug path added to the post-create slug-rotation flow.
- DNS-safe grammar + reserved-word blocklist + uniqueness, enforced server-side, mirrored
  client-side.
- Availability lookup endpoint (or equivalent) for live feedback.
- Public + custom-slug informational heads-up in the share flow.

**Deferred for later**
- Custom slug via MCP `create_canvas` / deploy API.
- Old-slug redirects or parking on rename.
- Cross-instance / cross-org slug reservation.

## Decisions made (during brainstorm)

1. **Allow custom slugs on any canvas** (not gated to public-only). Obscurity is
   defense-in-depth only, consistent with the trusted-org trust model; the public+custom
   heads-up is the safety net.
2. **One DNS-safe grammar in both URL modes** (prod runs subdomain mode), so a slug behaves
   identically everywhere rather than being path-permissive but subdomain-invalid.
3. **Scope = create-time + post-create rename**, not agents. Rename reuses the existing
   slug-rotation flow and its invalidation/socket-drop semantics.
4. **Gentle normalization + live URL preview** in the create field (lowercase, spaces→hyphen),
   rather than hard-rejecting every keystroke.

## Open questions (for planning)

- Exact final reserved-word list — reconcile with existing path/subdomain reservations so
  there is a single source of truth, not two drifting lists.
- Availability-check shape: a dedicated `GET …/slug-available?slug=` endpoint vs. validating
  on submit only. (Brainstorm assumes a debounced lookup for the live warning; planning picks
  the concrete contract.)
- On rename, should the freed old slug be immediately claimable by another canvas, or briefly
  reserved? Default: immediately claimable (matches today); flag if planning sees a real
  impersonation risk under the trust model.

## Success criteria

- Creating a canvas with an empty slug yields a random slug, unchanged from today.
- Creating with a valid custom slug yields a canvas reachable at that exact slug in the
  instance's URL mode.
- An invalid slug (bad chars, reserved, leading/trailing hyphen, >63 chars, empty after
  normalization) and a taken slug are both rejected with clear inline feedback and a blocked
  submit — and rejected server-side even if the client check is bypassed.
- Renaming to a custom slug invalidates the old URL, drops sockets, and serves at the new slug.
- A public canvas with a custom slug shows the human-guessable heads-up in the share flow.
- Both dialects (sqlite + postgres) green; new behavior has tests including the
  server-side rejection paths and the check-then-act race on create/rename.

## Handoff

Next: `/ce-plan` to turn this into an implementation plan, then `/ce-doc-review` on the plan.
