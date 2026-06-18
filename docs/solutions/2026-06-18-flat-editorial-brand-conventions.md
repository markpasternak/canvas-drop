---
title: Flat Editorial Creator OS — brand/UI conventions + the server-page contract
type: design
area: dashboard
date: 2026-06-18
---

The conventions every UI surface must follow after the rebrand, so the dashboard,
the gallery, the detail tabs, and **every server-rendered page** read as one product.
`DESIGN.md` is the spec; this is the load-bearing summary + the traps. Builds on
[[2026-06-13-dashboard-spa-patterns]] (token re-skin contract) and
[[2026-06-15-canvas-publication-state-vocabulary]] (tab names).

## The three type voices (the most-violated rule)

- **Serif — Newsreader** carries *meaning*: page titles, section headings, card titles,
  detail-rail titles, marketing headlines. `font-family: var(--font-serif)` +
  `font-optical-sizing: auto`, weight 400–500.
- **Sans — Geist** carries *controls*: body, labels, buttons, nav, meta, stats, tables,
  forms. `.tabular-nums` for stats/counts/versions.
- **Mono — Geist Mono** carries *identifiers*: slugs, URLs, primitive tags (`kv`), API
  names (`me()`), keys, version numbers, code.

The recurring drift: a **sans bold title** where a serif one belongs (the error pages,
legal pages, and docs all shipped this and had to be fixed). If it's a title or a
section heading, it's serif. Never set a button, table cell, or dense data in serif.

## Flat, not boxy

Retire nested rounded "cards-in-cards." A section is a **flat hairline-divided band**,
not a `rounded-xl border bg-surface shadow` panel. The shared idiom:
`border-t border-border pt-6 first:border-t-0 first:pt-0` (exported as `flatBandClass`
from `apps/dashboard/src/components/SettingsSection.tsx` — reuse it, don't re-hardcode).

- Settings/Share/Backend sections, the detail-page shell (`CanvasDetailChrome`), the
  editor panes (`WorkspacePane`), and the admin disclosures (`CollapsibleSection`) are
  all flat now. The generic `Surface.Panel` card is **kept** for the surfaces that still
  want a card (onboarding/new/gallery) — flatten by *migrating those usages*, not by
  gutting `Panel`.
- A spec list (Code/Path, Access/Visibility/Status) = `dt`/`dd` rows with a hairline
  between them (see `DetailPanel`'s details list), not a sunken bordered box.
- `InlineNotice` (lightly rounded) is the **one** kept rounded element — genuine
  callouts only, not section chrome.

## Colour: quiet chrome, expressive content

One teal-accent primary CTA per surface (`DetailPanel.primaryClass` = `bg-accent` /
`secondaryClass` = flat hairline; rows use `rowPrimaryActionClass`). State shows via the
shared **concept-colors** map + `Badge`/`StatusBadge`, never colour alone (pair with a
dot/icon/label). Slop tells to avoid (DESIGN §"Patterns to avoid"): side-stripe accent
borders, gradient text, indigo-violet, per-section tracked eyebrows, identical card grids.
Colour energy belongs in canvas covers + the marketing "Committed" treatment (the landing
hero: teal→navy + the amber second accent), not the app chrome.

## Server-rendered pages share the brand layer

Error pages, the password gate, legal (privacy/terms), and the docs site are
self-contained HTML — they must still resolve to the **same tokens** as the SPA:

- Tokens come from `rampCssVars("light"|"dark")` (`@canvas-drop/shared`) — the single
  source the dashboard uses. Never hand-fork a ramp.
- **Self-host Newsreader**, never a CDN (org-agnostic, no phone-home): `@font-face` →
  `/fonts/newsreader-latin-wght-normal.woff2` (served same-origin by `brandAssetRoutes()`),
  plus `--font-serif`. The landing page, `SYSTEM_PAGE_STYLES` (error + gate), and the
  legal pages all do this; the docs inherit `SYSTEM_PAGE_STYLES`.
- `SYSTEM_PAGE_STYLES` (`apps/server/src/http/error-pages.ts`) is the shared system-page
  chrome for the **error pages AND the password gate** — flat, card-less, serif. Editing
  it re-skins both, by design. `DOCS_STYLES` *includes* `SYSTEM_PAGE_STYLES` then
  overrides `body`/`main`/`.brand` for its sidebar layout — so a system-style change can
  reach the docs; verify the docs overrides still hold.
- The brand mark geometry lives once in `@canvas-drop/shared` (`brand/logo.ts`,
  `viewBox="158 209 372 432"`); server pages use `BRAND_MARK` (driven by
  `--logo-frame`/`--logo-drop`). A logo change is a single edit.

## Theme: data-theme + the per-origin caveat

The dashboard persists the choice as `data-theme` on `<html>` + `localStorage`
`canvas-drop-theme` (`system` → no attribute → follow `prefers-color-scheme`). The
**docs site mirrors this exactly** (`THEME_CLIENT_JS` at `/docs/theme.js`, loaded in
`<head>` pre-paint, `script-src 'self'`; plus `:root[data-theme="…"]` token overrides
that outrank the media query, and a `?theme=` param for shareable links).

Other server pages (error/gate/legal) currently follow **OS only** (`prefers-color-scheme`).
To make them honour the stored choice they each need (1) the `:root[data-theme]` token
overrides and (2) the same pre-paint script. **But `localStorage` is per-origin:** this
works for app-origin pages (`/privacy`, `/terms`, `/docs`, the dashboard's own error
pages, and canvas pages in **path** URL mode). In **subdomain** URL mode (prod) a canvas
lives at `slug.<domain>` — a different origin — so its error/gate pages cannot read the
app's `localStorage` and stay OS-driven unless theme is moved to a **parent-domain cookie**
(`Domain=.<root>`), à la the OIDC/session cookies ([[2026-06-16-oidc-subdomain-cookie-and-returnto]]).
The password-gate cookie is deliberately host-only, so cross-subdomain state is a conscious step.

## Process traps

- **`pnpm format` before every commit.** Biome `lint` fails (exit 1) on formatter drift
  even when a subagent reports "lint ok" — run `pnpm format` then `pnpm lint`.
- Server page tests assert **content** (brand mark `viewBox`, titles, escaping, paths),
  not CSS — a visual redesign is safe as long as that content survives. The one exception
  found: a legal-page test that *forbade* a dark-scheme block ("light-mode only per the
  design brief") — stale after the brand went light-default **+ dark-alternate**; updated
  to assert dark support. Watch for tests encoding a superseded design decision.
