# Design — Editorial Creator OS

The visual system for canvas-drop. This is the **target**, not a transcript of
today's code — where the implementation lags, it's a to-do (see the rebrand plan in
`docs/plans/`). Strategy and voice live in [`PRODUCT.md`](PRODUCT.md); this file is
how it looks. Concrete brand values are mirrored in `design/BRAND-CUES.md`.

Tokens are defined in `apps/dashboard/src/styles/tokens.css` (fed by a shared
`BRAND_TOKENS` source) and consumed through Tailwind v4 utilities (`bg-surface`,
`text-fg`, `font-serif`, …). Components never hard-code a color, font, radius, or
shadow — every value resolves to a semantic variable, so a deployment re-skins by
editing the **brand layer**, never components.

## Theme

**Editorial Creator OS.** A calm, premium workspace for publishing and managing
visual artifacts. Editorial serif typography, warm neutral surfaces, restrained
color, soft tactile depth, and a three-panel app structure. The system UI stays
**quiet so the canvases carry the visual energy** — color comes from canvas covers,
status pills, the primary CTA, and the selected state, not from the chrome.

It should feel closer to a publishing CMS / creative operating system than an
enterprise admin. Reference feel: a refined design tool — "paper, panels, and
objects." Explicitly **not** gradient-SaaS, **not** Bootstrap admin, and **not** the
default indigo-violet SaaS palette.

- **Light is the default**; dark is the system-driven alternate (`prefers-color-scheme`),
  with a manual override via `[data-theme]`.
- **Color strategy: Restrained in the app, Committed in marketing.** App chrome stays
  near-monochrome warm neutral + one teal accent (<~10% of any screen). Marketing
  surfaces (landing, signed-out, big empty-state moments) earn a Committed treatment
  with a drenched hero and the amber second accent.

## Token layering (re-skin contract)

Two layers. Swapping the brand is a brand-layer edit; the system layer is untouched.

- **System layer** — the neutral ramp *geometry*, radii, easing, shadow geometry,
  type scale, spacing. Brand-independent.
- **Brand layer** (`packages/shared` → `BRAND` + `BRAND_TOKENS`) — the accent hue,
  the warm-neutral tint, the fonts, the logo, the product name, theme-color. Every
  surface (dashboard SPA + every server renderer) consumes the single `BRAND_TOKENS`
  source; a **parity test** (modeled on the dual-dialect schema-parity test) fails CI
  if any surface drifts from it. `REBRAND.md` enumerates every seam.

## Color

Authored in **OKLCH** for a perceptually even ramp and predictable contrast. All
pairings target **WCAG 2.1 AA** (body ≥4.5:1, large/UI ≥3:1). Hex values are derived
approximations; OKLCH is canonical.

### Neutral ramp — warm paper (light, default) / deep navy (dark)
Light is warm paper (hue ~85, low chroma) — never stark white. Dark is deep navy
(hue ~265, real chroma) — never pure black.

| role | light OKLCH (~hex) | dark OKLCH (~hex) |
|---|---|---|
| `--canvas` | `0.969 0.008 85` (`#f7f4ed`) | `0.175 0.018 265` (`#14161f`) |
| `--surface` | `0.987 0.006 85` (`#fbf9f3`) | `0.212 0.020 265` (`#1b1e29`) |
| `--surface-raised` | `0.998 0.004 85` (`#fffef9`) | `0.245 0.022 265` (`#222533`) |
| `--surface-sunken` | `0.945 0.010 85` | `0.150 0.016 265` |
| `--fg` | `0.255 0.012 75` (`#2f2a23`) | `0.965 0.004 265` (`#f3f3f6`) |
| `--muted` | `0.475 0.012 75` | `0.715 0.014 265` |
| `--subtle` | `0.500 0.012 75` (AA-tuned) | `0.620 0.014 265` (AA-tuned) |
| `--border` | `0.895 0.010 85` | `0.295 0.020 265` |
| `--border-strong` | `0.820 0.012 75` | `0.390 0.022 265` |

### Accent — deep teal (hue ~200), the primary chromatic identity
Deliberately **not** indigo-violet (the SaaS default). Distinctive, premium, and it
pops on both warm paper and deep navy.

- `--accent` — light `0.49 0.105 200` (`#0c7b88`) · dark `0.78 0.105 195` (`#56c9d3`).
  Primary buttons, current selection, active nav, links, focus ring.
- `--accent-hover`, `--accent-fg` (≥4.5:1 on the fill), `--accent-subtle` (selected /
  badge / info backgrounds; `text-accent` on it clears 4.5:1).

### Second accent — warm amber (hue ~72), MARKETING ONLY
The editorial warm-cool counterpoint. `--amber` `0.78 0.15 72` (`#e0a23a`) /
`--amber-ink` `0.52 0.13 60` for AA text on paper. Used on the landing/signed-out
surfaces (drenched hero/CTA, eyebrows, the italic-emphasis move). **The app stays
single-accent teal.**

### Semantic — `success` (green ~152), `warning` (amber ~58/80-dark), `danger` (red ~27)
Each has a foreground + a `-subtle` background. **Never encode state in color alone** —
always pair with a dot, icon, or label (`StatusBadge`).

### Canvas covers
Derive cover gradients from the **accent hue ±offset**, not the full spectrum, so the
gallery reads on-brand even with auto-screenshots off. Covers + canvas content are
where color is allowed to be loud.

## Typography

Three voices, strict duties. All three are brand tokens (swappable to re-voice) and
**self-hosted** in production (org-agnostic, no phone-home).

### Serif — Newsreader *(the content voice — the editorial signature)*
Variable, optical-sizing on, real italic.
- **Use for:** page titles, section headings, card titles, detail-rail titles, lead /
  intro prose, marketing headlines.
- **Weights:** 400 display/hero, 500 titles. Optical sizing **auto** (large cuts get
  character, small cuts stay legible). Tight tracking on large headings (`-0.02em`).
- **Italic = emphasis**, in the accent color, sparingly — once per view (the house
  move, e.g. "Drop it in. *Share it out.*").

### Sans — Geist *(the functional voice)*
Body, labels, buttons, nav, meta, stats, tables, forms. Weights 400 body / 500 label /
600 emphasis. `.tabular-nums` for stats, counts, sizes, versions.

### Mono — Geist Mono *(the machine voice)*
Slugs, URLs, primitive tags (`kv`), API names (`me()`), keys, version numbers, code.

**The rule:** serif carries meaning, sans carries controls, mono carries identifiers.
Never set a button, table cell, or dense data in serif.

### Scale (registered as `--text-*` utilities)
Fixed-rem (product UI, not fluid). Serif display steps + sans UI steps share one
scale: hero serif `~2.4rem/400`, page-title serif `~1.9rem/400`, section serif
`1.3rem/500`, card-title serif `1.05–1.15rem/500`, body sans `0.9375rem`, label
`0.8125rem/500`, meta `0.6875–0.75rem/500 --subtle`.

## Elevation & shape — soft, tactile ("paper & objects")

Retires the old crisp-flat look. Elevation is a **scale** registered as `--shadow-*`
utilities: two layers (close ambient + far diffuse), **warm-tinted in light** (hue ~40),
deep navy in dark. Softer and slightly larger than crisp — but never a muddy 60px blur.

- Radii (generous): `sm 0.5rem` (chips), `md 0.75rem` (controls/inputs), `lg 1rem`
  (menus/wells), `xl 1.25rem` (cards), `2xl 1.5rem` (panels/panes/tiles).
- Elevation pairs with a hairline border; a surface is defined by its edge first.
- Buttons are tactile: resting `--shadow-ctrl`, `active:translate-y-px`.

## Motion

State, feedback, reveal — never decoration. `--ease-out` `cubic-bezier(0.16,1,0.3,1)`,
**≤180ms**. A small keyframe set: fade+scale for overlays/menus, slide-up for toasts,
2–3px hover-lift on cards, tactile button press. Animate transform/opacity only. Every
animation has a `prefers-reduced-motion` path (and reduced-motion must preserve
essential feedback — e.g. a "Saving…" label when a spinner is suppressed).

## Layout & structure — three-panel Creator workspace

The dashboard is an **app shell**, not a page:

- **Left rail** — primary nav (Canvases, Gallery, and Admin for admins) + account.
  (Templates / Shared / Trash are aspirational — not shipped as their own sections.)
- **Center** — the working library: **gallery-first**, cards are the hero, metadata
  secondary; a stat strip, search, segmented filters, filter chips above the grid.
- **Right detail rail** — the selected canvas as a living object: cover, status, primary
  actions (Open / Share / Duplicate / More), Details (Access / Visibility / Status /
  edited / created), and recent activity. Selecting a card populates the rail (no
  navigation); the full detail route holds the deep surfaces (editor, versions, usage,
  settings, share management, backend). The rail is the inline "overview."

**Responsive collapse:** ≥1280 all three panels · 1024–1280 right rail → slide-in
drawer on selection · 768–1024 left rail → icon/hamburger, right → drawer · <768 single
column, card tap → bottom sheet, gallery 1–2 col. Reuse the existing mobile-menu +
`Dialog` focus-trap patterns.

## Components

Every interactive component ships the full state set: **default, hover, focus-visible,
active, disabled, loading**. Half a set is a bug. Shared primitives + layout scaffolds
own the patterns so a concept changes in one place:

- **Primitives:** `Button`, `IconButton`, `Badge`/`StatusBadge`, `Field`/`SearchInput`,
  `Toggle`, `SegmentedControl`, `TabNav`, `DataTable`, `Tag`, `CodeBox`, `Dialog`,
  `ActionMenu` — one shared `Variant`/`Tone` + `Size` vocabulary; ARIA baked in once
  (`aria-pressed` on segments, `aria-current`/`activeProps` on tabs).
- **Layout scaffolds:** `AppLayout` (the three-panel shell, `apps/dashboard/src/app-layout.tsx`), `DetailPanel` (right rail),
  `CanvasCard` (the hero card), the `Surface` family (`PageHeader`/`Panel`/`Section`).
- **Empty states** teach the next action (icon + one line + a verb). **Loading** uses
  skeletons matched to the real layout, never a centered spinner mid-content.

### Patterns to avoid (slop tells)
Side-stripe accent borders; the hero-metric template (8 identical stat cards — use a
divided strip); identical card grids; gradient text; glassmorphism; per-section tracked
eyebrows; numbered section scaffolding; modal-as-first-thought; **indigo-violet**; pure
white / pure black; serif on controls or dense data; state-by-color-alone.

## Logo

The **drop-frame** mark: a rounded-square frame, a bold download arrow dropping in
through the top, and `</>` filling the body (drop a web tool in). Frame in ink, arrow +
`</>` in teal; on the accent tile the whole mark goes white. Drawn as SVG paths (no
font dependency) — see `design/brand/canvas-drop-mark.svg`. Wordmark "canvas-drop":
Geist 600, lowercase, `-0.03em` tracking. One source feeds the favicon, PWA icons, and
the app tile.

## Accessibility

WCAG 2.1 AA. Always-visible accent focus ring (`:focus-visible`, follows each control's
radius, never removed). Full keyboard reachability, including the three-panel selection
flow and overlays (focus-trap + Escape). Contrast verified on the actual surface in
both themes (the dark ramp is declared once so both dark paths match). Color never the
sole carrier of meaning. Respect reduced motion while preserving essential feedback.
