# Public marketing micro-site (instance front door) — Requirements

**Date:** 2026-06-16
**Status:** Ready for planning
**Scope:** Standard / Deep-feature

## Summary

Build a public, signed-out front door for the canvas-drop.com instance served at the
root URL (`/`). Today a signed-out visitor hitting `/` is bounced straight to Google
login with zero context about what canvas-drop is. This replaces that with a
multi-section marketing micro-site (hero → features → primitives showcase → gallery
preview → self-host CTA → footer) that explains the product, drives sign-in, and links
out to docs, terms, privacy, and GitHub. Signed-in users still get the dashboard at `/`
unchanged. Screenshots are regenerable via the existing `pnpm docs:screenshots`
pipeline, and the app links back to the site via a footer "About" link.

## Problem Frame

canvas-drop already ships every public-facing piece *except the page that ties them
together*: `/privacy` and `/terms` exist as self-rendered branded HTML, `/docs/*` is
public, OG social cards exist, and a Playwright screenshot pipeline
(`scripts/screenshots.mjs`) already captures dashboard screens to WebP. But the root
URL — the first thing anyone who is handed `canvas-drop.com` sees — is a bare redirect
to a Google sign-in screen. There is no moment where the product introduces itself, no
public hub linking the surfaces that already exist, and no visual proof of what the
product does. The pieces are built; nothing assembles them into a front door.

## Key Decisions

- **Audience is the instance front door, not OSS adopter marketing.** The page's job is
  to orient a signed-out visitor who landed on canvas-drop.com and move them to sign in.
  A self-host / OSS track exists but is secondary (one CTA to GitHub), not the spine.

- **Landing lives at the root (`/`), session-branched.** Signed-out `/` serves the
  micro-site; signed-in `/` serves the dashboard exactly as today. The URL "just works"
  as a front door rather than living at a secondary path. This is the standard SaaS
  pattern and was chosen over a `/welcome` redirect hop.

- **Fuller marketing page, not a one-screen splash.** Multiple sections: hero + primary
  sign-in CTA, feature blocks, the five-primitives showcase, a gallery preview, a
  self-host/OSS CTA, and a footer. Several screenshots; light polish/animation allowed.

- **canvas-drop.com-flavored copy, like the legal pages.** The page may reference
  canvas-drop.com directly and take positioning freedom for this deployment. Operator-
  /instance-specific copy is centralized in one constant (mirroring `OPERATOR` in
  `apps/server/src/http/legal-pages.ts`) so a self-hoster who clones has one obvious
  place to edit. This accepts the same tradeoff the legal pages already make.

- **Self-rendered static HTML, served pre-gateway.** Built the same way as the legal
  pages: a server-rendered HTML string with inline CSS and at most minimal vanilla JS —
  no SPA bundle (the SPA is gated and unavailable signed-out) and no server-side build
  step (static-first principle). Mounted before the auth gateway alongside `/privacy`,
  `/terms`, and `/docs`.

- **High design bar — distinct from the legal pages.** The legal pages are deliberately
  plain (light-mode static text). This front door is the opposite: it should be a
  genuinely well-designed marketing page — strong typography, composition, considered
  color/spacing, and tasteful motion — not a styled text document. The static-HTML
  delivery constraint stays, but the visual ambition is high. Design quality is a
  first-class requirement, not a polish afterthought.

- **Gallery is shown, not linked.** The gallery requires an org session, so a signed-out
  landing cannot link to a live gallery without bouncing to login. The page shows a
  gallery *screenshot* instead, preserving the trust model unchanged.

- **Screenshots reuse the existing pipeline.** Extend `scripts/screenshots.mjs`
  (`pnpm docs:screenshots`) with the landing's shots and an output path the site serves;
  commit optimized WebP. No new tooling. This is the "regenerate" button.

## Requirements

### Page & routing

- **R1.** Serving the root URL (`/`) to a request **with no authenticated principal**
  renders the marketing micro-site (HTTP 200, public, cacheable). The page is reachable
  while signed out on every host the instance answers on.
- **R2.** Serving `/` to a request **with** an authenticated org session continues to
  serve the dashboard SPA exactly as today — the front door must not regress the
  signed-in experience.
- **R3.** The page is served before the auth gateway, mounted alongside the existing
  public surfaces (`/privacy`, `/terms`, `/docs`), and must not be shadowed by the
  existing `socialPreview` crawler intercept at `/` — crawlers and humans both receive
  the real landing HTML.
- **R4.** The page carries its own social/OG metadata (title, description, `og:image`)
  as the canonical `/` document, consistent with how the legal pages emit OG tags.

### Content & sections

- **R5.** A hero section states what canvas-drop is in one line and presents a primary
  **Sign in** call to action that routes to the instance's real login entry point
  (`/auth/login` in oidc mode).
- **R6.** Feature section(s) describe the core value (deploy and share small AI-built
  web artifacts) in scannable blocks.
- **R7.** A primitives showcase presents the five primitives (KV, files, AI, identity,
  realtime).
- **R8.** A gallery-preview section shows the gallery via a screenshot (not a live
  link).
- **R9.** A self-host / OSS section links to the GitHub project
  (`https://github.com/markpasternak/canvas-drop`) and/or the self-host docs.
- **R10.** A footer links to Docs, Terms (`/terms`), Privacy (`/privacy`), and GitHub.
- **R11.** All instance-/operator-specific copy is centralized in a single constant so
  it is editable in one place by a self-hoster.

### Screenshots

- **R12.** The landing's screenshots are produced by the existing
  `scripts/screenshots.mjs` (extend its `SHOTS` list and output directory); the
  optimized WebP outputs are committed so the page renders without running the pipeline.
- **R13.** Every captured screen is free of seeded or operator-specific data (the
  screenshot script already mandates this), even though the surrounding landing *copy*
  is canvas-drop.com-flavored.

### Reachability from the app

- **R14.** The signed-in app exposes a link back to the public site so authenticated
  members can reach the front door. Because a signed-in `GET /` serves the dashboard
  (R2), the landing is also served at an **always-public alias `/welcome`** that renders
  the marketing page regardless of session; the in-app account menu links there ("About
  canvas-drop").
- **R16.** Signing out lands on the welcome page: `/auth/logout` revokes the session and
  redirects to `/welcome` (not `/`, which would re-challenge the now-signed-out visitor
  straight into login).

### Design quality

- **R15.** The page meets a high visual-design bar — deliberate typography, composition,
  color, spacing, and tasteful motion — clearly distinct from the intentionally-plain
  `/privacy` and `/terms` pages. It should read as a designed marketing page, not a
  styled text document, while staying within the static-HTML + inline-CSS + minimal-JS
  delivery constraint.

## Key Flows

**Signed-out visitor → sign in**
1. Visitor opens `canvas-drop.com/` with no session.
2. Server detects no principal and renders the micro-site (R1).
3. Visitor reads hero/features/primitives/gallery, clicks **Sign in** (R5).
4. Standard oidc login (Google) → on success the visitor lands in the dashboard at `/`
   (R2 path now applies).

**Signed-in user → back to the front door**
1. Authenticated user clicks the footer "About" link in the app (R14).
2. They view the public site. (They retain their session; returning to `/` shows the
   dashboard.)

**Owner regenerates screenshots**
1. Owner runs the dev dashboard locally and `pnpm docs:screenshots` (R12).
2. Playwright recaptures the configured screens (clean/org-agnostic state, R13),
   re-encodes to WebP, writes to the site's asset dir; owner commits the refreshed
   images.

## Scope Boundaries

**In scope**
- Public micro-site at `/` for signed-out visitors (oidc/dev modes).
- Multi-section marketing content + committed screenshots.
- Footer "About" link from the app back to the site.
- Extension of the existing screenshot pipeline.

**Deferred for later**
- Making the gallery itself public (would change the trust model; out of this feature).
- A dedicated OSS marketing site / docs-site landing aimed at self-host adopters (the
  audience choice was front-door first).
- Localization / multi-language copy.
- Analytics on the landing (org-agnostic / no-phone-home posture; revisit only if ever
  wanted and privacy-compatible).

**Outside this feature's identity**
- This is the *instance* front door, not the open-source project's marketing home. It
  markets canvas-drop.com, not "adopt canvas-drop the framework."

## Dependencies & Assumptions

- **Auth mode.** The landing is an **oidc/dev-mode** surface. In `proxy` mode the IAP
  authenticates before the app, so a signed-out `/` is never reached; the front door
  simply doesn't apply there (consistent with how the guest resolver is mounted only in
  app-gated modes). Prod (canvas-drop.com) runs oidc, so this is fine.
- **Pre-gateway ordering is delicate.** Inserting the root-landing branch interacts with
  the existing pre-gateway chain (`legalRoutes`, `docsRoutes`, guest carve-out,
  `socialPreview`, `authGateway` behind `onlyWhenNoPrincipal`). Planning must place the
  branch so signed-out `/` resolves to the landing and signed-in `/` falls through to
  the SPA, without breaking guest/public canvas resolution or the OG crawler path.
- **Screenshot pipeline prerequisites** (already documented in the script): a running
  dev dashboard, Playwright + sharp installed, `pnpm exec playwright install chromium`.
- **Existing assets to reuse:** legal-page rendering style and `OPERATOR` constant
  pattern (`apps/server/src/http/legal-pages.ts`), the brand logo SVG used there, OG
  card at `/og.png`, and the README product pitch as copy source.

## Follow-up: OG coverage on shared canvas URLs

A separate concern raised during build: **do the URLs users share get an OG image?**
Audit of the current behavior:

| Shared URL | OG image today |
| --- | --- |
| `/`, `/welcome` (landing) | ✅ built (own OG tags → `/og.png`, indexable) |
| `/privacy`, `/terms`, `/docs/*` | ✅ existing |
| Signed-out unfurl of a **gated** canvas | ✅ generic card via `socialPreview` (deliberately generic — never leaks a gated canvas's title/existence pre-auth) |
| **Public / guest-shared canvas** | ❌ **gap** — once a principal resolves (public link or guest), `socialPreview` steps aside (`social-preview.ts:49`) and the raw static artifact is served, so unless the author added their own `<meta>`, the unfurl is bare |

**Resolved (2026-06-16):** `socialPreview` now serves a **per-canvas OG card** for a
`public_link` canvas (anonymous principal — set by the resolver *only* for public_link
canvases, so a gated canvas can never reach this branch and its title can't leak). The
card carries the canvas's already-public title and is served **only to crawler
user-agents**; a real human visitor falls through to the canvas itself. The title is
HTML-escaped (user-controlled) and the card stays `noindex` (a public link is
"anyone with the URL", not search-discoverable). Guest-invited canvases keep the generic
card. Tested in `apps/server/src/http/social-preview.test.ts`.

## Open Questions

- **OG image:** reuse the existing generic `/og.png`, or generate a landing-specific
  card? (Reuse is the low-cost default.)
- **Animation budget:** how much motion/polish on the static page before it's worth a
  tiny vanilla-JS file vs. pure CSS? (Lean CSS-only unless a specific effect needs JS.)
- **Sign-in entry in dev mode:** confirm the CTA target degrades sensibly when auth mode
  is `dev` (auto-login) vs `oidc`.
