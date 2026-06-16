# Design

The visual system for the canvas-drop dashboard. This is the **target**, not a
transcript of today's code — where the implementation lags, it's a to-do. Strategy
and voice live in [`PRODUCT.md`](PRODUCT.md); this file is how it looks.

Tokens are defined in `apps/dashboard/src/styles/tokens.css` and consumed through
Tailwind v4 utilities (`bg-surface`, `text-fg`, `border-border`, …). Components
never hard-code a color, font, radius, or shadow — every value resolves to a
semantic variable so a deployment re-skins by editing tokens, never components.

## Theme

**Minimal editorial, sharpened.** A cool-neutral graphite ramp carries the whole
interface; a single indigo-violet accent does all the pointing. The tool is a
precise instrument — it disappears into the task. Restraint is the brand: edges
are crisp, elevation is short, color is reserved for meaning (primary action,
current selection, state). Light and dark are both first-class and equally tuned.

Reference feel: **Linear** — fast, opinionated, near-monochrome, keyboard-respectful,
nothing decorative. Explicitly **not** gradient-SaaS and **not** enterprise/Bootstrap
admin (see PRODUCT.md anti-references).

Color strategy: **Restrained** — tinted-neutral surfaces + one accent under ~10%
of the surface. A single screen may earn Committed (a drenched onboarding hero),
but Restrained is the floor.

## Color

Authored in **OKLCH** for a perceptually even ramp and predictable contrast. All
pairings target **WCAG 2.1 AA** (body ≥4.5:1, large/UI ≥3:1, placeholders 4.5:1).

### Neutral ramp (role → light / dark intent)
- `--canvas` — app background; the sunken floor. Slightly darker than surface so cards lift.
- `--surface` — default card / panel surface.
- `--surface-raised` — pure white (light) / lifted panel (dark); headers, raised controls.
- `--surface-sunken` — wells: segmented controls, code gutters, nav troughs.
- `--surface-hover` — row/control hover.
- `--fg` — primary text and icons (cool near-black / near-white).
- `--muted` — secondary text; passes 4.5:1 on surface.
- `--subtle` — tertiary labels, meta, eyebrows; tuned to clear 4.5:1 at small sizes (do **not** use lighter for "elegance").
- `--border` — default hairline; must read against surface in **both** themes.
- `--border-strong` — emphasized dividers, secondary-button outline, input borders.

### Accent — indigo-violet (hue ~274)
- `--accent` — primary buttons, current selection, active nav, links, focus ring. ~10% surface max.
- `--accent-hover` — darkens in light, lightens in dark.
- `--accent-fg` — text/icon on an accent fill (≥4.5:1).
- `--accent-subtle` — selected-row / badge / info backgrounds; `text-accent` on it clears 4.5:1.

### Semantic — `success` (green ~152), `warning` (amber ~58; ~80 in dark for AA), `danger` (red ~27)
Each has a foreground and a `-subtle` background. **Never encode state in color
alone** — always pair with a dot, icon, or label (see `StatusBadge`).

## Typography

One family carries everything: **Geist Variable** (UI) + **Geist Mono Variable**
(identifiers). No display/body pairing — product UI doesn't need it.

- **Family discipline.** Sans for all prose, labels, buttons, headings. Mono **only**
  for machine text: slugs, URLs, secret keys, version tags, byte counts, IDs. Mono is
  the signal "this is an identifier you can copy," so don't spend it on decoration.
- **Numerals.** Stats, sizes, counts, quotas, and version numbers use `.tabular-nums`
  so changing values and columns stay aligned.
- **Scale (fixed rem, not fluid).** Product UI is viewed at consistent DPI; clamp-sized
  headings would shrink in panels. Steps (ratio ≈1.2):
  - Page title (`h1`): **1.5rem / 600 / -0.02em**, `text-wrap: balance`.
  - Section heading: 1.0625–1.125rem / 600.
  - Body: 0.9375rem / 1.55.
  - Label / control: 0.8125rem / 500.
  - Meta / eyebrow: 0.6875–0.75rem / 500, `--subtle`.
- **Headings** carry tight tracking (−0.014em base, −0.02em at display size); never
  looser, never tighter than −0.04em.
- **Line length** for prose caps at ~65–75ch (`max-w-2xl` on descriptions). Tables and
  dense data may run wider.

## Space & radius

- **Spacing** uses the Tailwind 4px scale. Vary rhythm — page gutters `px-5`,
  section gaps `gap-5`/`gap-6`, tight control gaps `gap-1.5`/`gap-2`. Generous
  whitespace is part of the restraint; don't fill it with chrome.
- **Page width** `max-w-[112rem]` shell; reading content (forms, prose) constrained
  narrower so lines don't sprawl.
- **Radius** (tightened for precision): `sm 6px` (badges, chips), `md 8px` (buttons,
  inputs, controls), `lg 10px` (nav wells, menus), `xl 14px` (panels, panes). Crisp,
  not pillowy.

## Elevation

A **scale**, not one value. Crisp and short — never a soft 60px blur. Cool-tinted
in light, deep in dark.

- `--shadow-xs` — resting controls (primary button, raised toggle thumb).
- `--shadow-sm` — low cards, hovered rows.
- `--shadow-panel` — default card / pane resting elevation.
- `--shadow-md` — raised menus, hovered cards.
- `--shadow-popover` — dropdowns, comboboxes, command menus.
- `--shadow-lg` — dialogs / modals (over `--scrim`).
- `--shadow-focus` — 3px accent ring halo for emphasis.

Elevation pairs with a border, never replaces it — a surface is defined by its
edge first, its shadow second.

## Components

Every interactive component ships the full state set: **default, hover, focus-visible,
active, disabled, loading**. Half a set is a bug.

- **Buttons** — `primary` (accent fill, `--shadow-xs`), `secondary` (raised surface +
  `border-strong`), `ghost` (text → fg on hover well), `danger`. Sizes `sm`/`md`,
  `rounded-md`, `active:translate-y-px`, spinner on `loading`.
- **Inputs / fields** — `surface-raised`, `border-strong`, `rounded-md`; focus shows the
  accent ring; error state borders `--danger` with a message (never color alone).
- **Toggles** — accent track when on, `border-strong` when off; thumb lifts with `--shadow-xs`.
- **Badges** — `rounded-md`, subtle-tinted by tone; `StatusBadge` always carries a dot.
- **Panels / panes** (`Panel`, `WorkspacePane`) — `surface`, `border`, `rounded-xl`,
  `--shadow-panel`. Section internals divide with borders, not nested cards.
- **Nav** — section nav is a sunken segmented well; the active item is a raised
  `surface` chip with `--shadow-xs` (a chip, **not** a side-stripe). Canvas-detail
  tabs use an accent underline. The settings sub-nav is a sticky vertical **TOC
  rail**: a full-height hairline rail with the active item's segment in `--accent`.
  This rail is the one legitimate left-border affordance — the marker *is* the
  navigation, not decoration on a card (see the side-stripe note below).
- **Tables** (admin) — sticky header in `surface-raised`, hairline row borders, hover
  in `surface-hover`, numerics tabular and right-aligned.
- **Empty states** teach the next action (icon + one line + a verb), they don't just
  say "nothing here." **Loading** uses skeletons matched to the real layout, never a
  centered spinner mid-content.

### Patterns to avoid (this project's slop tells)
- Side-stripe accent borders (`border-left` as decoration) — use a chip, a full border, or a tint.
- The hero-metric template — big number + small label + accent, repeated in identical boxes.
  Admin stats read as a compact divided strip, not 8 cards.
- Identical card grids, gradient text, decorative glassmorphism, per-section tracked eyebrows,
  numbered section scaffolding, modal-as-first-thought. (See PRODUCT.md + shared bans.)

## Motion

State, feedback, and reveal — never decoration. `--ease-out` (`cubic-bezier(0.16,1,0.3,1)`),
durations **≤180ms** for most transitions (color/opacity/transform). No orchestrated
page-load sequences; product loads into a task. List entrances may stagger; nothing
else does. Every animation has a `prefers-reduced-motion: reduce` path (the base layer
collapses transitions to ~0ms). Animate transform/opacity, not layout.

## Accessibility

WCAG 2.1 AA. Always-visible accent focus ring (`:focus-visible`, never removed).
Full keyboard reachability. Contrast verified on the actual surface, including
placeholders and small `--subtle` labels. Color never the sole carrier of meaning.
Dark and light equally maintained. Respect reduced motion.
