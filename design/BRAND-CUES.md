# canvas-drop — Brand cues (Editorial Creator OS)

How it should look and feel. A calm, premium workspace for publishing and managing
visual artifacts. Editorial typography, warm neutral surfaces, restrained colour,
soft tactile depth. The system UI stays quiet so the canvases carry the energy.

**One-line:** *Premium archive workspace for creative artifacts — paper, panels, and objects.*

Author colour in **OKLCH** (perceptually even, predictable contrast). Hex values
below are derived approximations for tools that need them — the OKLCH is canonical.

---

## Colour

### Light — warm paper (DEFAULT)
| Role | OKLCH | ~Hex | Use |
|---|---|---|---|
| canvas | `0.972 0.004 85` | `#f7f6f3` | app/page background — warm paper floor |
| surface | `0.992 0.003 85` | `#fdfcfa` | default card / panel |
| surface-raised | `0.998 0.002 85` | `#fffefd` | headers, raised controls (near-white, faintly warm) |
| surface-sunken | `0.943 0.006 85` | `#eeece8` | wells: segmented controls, code gutters |
| fg | `0.250 0.009 75` | `#24211d` | primary text — warm near-black, never pure `#000` |
| muted | `0.460 0.009 75` | `#5b5753` | secondary text (AA) |
| subtle | `0.500 0.009 75` | `#66635e` | tertiary/meta (AA-tuned — don't go lighter) |
| border | `0.865 0.007 85` | `#d5d2cd` | hairline divider |
| border-strong | `0.770 0.010 75` | `#b8b3ad` | input borders, secondary-button outline |

### Dark — graphite (system alternate)
| Role | OKLCH | ~Hex | Use |
|---|---|---|---|
| canvas | `0.205 0.006 80` | `#191714` | graphite floor — never pure black |
| surface | `0.240 0.006 80` | `#211f1c` | default card / panel |
| surface-raised | `0.280 0.007 80` | `#2b2925` | headers, raised controls |
| fg | `0.954 0.005 85` | `#f1f0ec` | primary text |
| muted | `0.740 0.008 85` | `#adaaa5` | secondary text |
| subtle | `0.670 0.008 85` | `#979590` | tertiary/meta (AA-tuned) |
| border | `0.350 0.008 80` | `#3d3a36` | hairline divider |

### Accent — deep teal (hue ~190), the primary chromatic identity
Deep teal connects the light and dark themes. Keep it restrained so controls are
recognizable and canvas content carries the visual variety.

| Role | Light OKLCH (~hex) | Dark OKLCH (~hex) |
|---|---|---|
| accent | `0.48 0.085 190` (`#006d68`) | `0.76 0.075 190` (`#76c1bc`) |
| accent-hover | `0.42 0.080 190` (`#005b57`) | `0.81 0.070 190` (`#8bd0cb`) |
| accent-fg (text on accent) | `0.99 0.005 190` (`#f8fdfc`) | `0.18 0.015 190` (`#0a1413`) |
| accent-subtle (badge/selected bg) | `0.935 0.025 190` (`#d8efed`) | `0.30 0.034 190` (`#183332`) |

Used for: primary CTA, current selection, active nav, links, focus ring.
**Keep accent under ~10% of any screen.** Everything else is warm neutral.

### Legacy marketing accent
The warm amber tokens remain available for older artwork. The current homepage
uses the active skin's accent on the same neutral surfaces as the app; there is
no separate hero palette.

### Semantic (state) — always paired with a dot/icon/label, never colour alone
- success `0.52 0.13 152` (`#137d41`) · subtle `0.95 0.04 152`
- warning `0.53 0.14 58` (`#a55200`) · subtle `0.95 0.05 80`
- danger  `0.555 0.205 27` (`#d02526`) · subtle `0.96 0.022 27`

### Canvas covers
Derive cover gradients from the **accent hue ±offset** (warm violet→blue→amber
sweep), not the full spectrum — so the gallery reads on-brand even with auto-
screenshots off. Covers and content are where colour is allowed to be loud.

---

## Typography

Three voices, strict separation of duties.

### Serif — Newsreader *(the content voice)*
Variable, optical-sizing on, has a real italic. **This is the editorial signature.**
- **Use for:** page titles, section headings, card titles, detail-rail titles,
  lead/intro prose, marketing headlines.
- **Weights:** 400 for display/hero, 500 for titles. Never bold-heavy.
- **Optical sizing: auto** — large cuts get character, small cuts stay legible.
- **Tracking:** slightly tight on large headings (`-0.02em`).
- **Italic = emphasis** — the house move is an italic accent clause in the accent
  colour (e.g. "Drop it in. *Share it out.*"). Use sparingly, once per view.

### Sans — Geist *(the functional voice)*
- **Use for:** body text, labels, buttons, nav, meta, stats, tables, forms,
  tooltips — everything operational.
- **Weights:** 400 body, 500 labels, 600 emphasis/buttons.

### Mono — Geist Mono *(the machine voice)*
- **Use for:** slugs, URLs, primitive tags (`kv`, `files`), API names (`me()`),
  keys, version numbers, code.
- **Tabular figures** for stats, counts, sizes, dates so columns stay aligned.

**The rule:** serif carries meaning, sans carries controls, mono carries
identifiers. Never set a button, table cell, or dense data in serif.

Fonts are **self-hosted** in production (org-agnostic, no phone-home). All three
are brand tokens — a self-hoster swaps `fontSerif`/`fontSans`/`fontMono` to
re-voice without touching components.

---

## Logo

Keep the "**drop into frame**" mark: a rounded-square bracket/frame with a
downward arrow landing on a tray line — literal "canvas-drop". On a rounded-square
tile (radius ~9px) filled with the accent, glyph in white; or framed in `fg` with
the arrow in `accent` on neutral surfaces. Wordmark "canvas-drop" in Geist 600,
tight tracking. *(New mock-logo pending — will replace the current `cd` mark across
the mark SVG, favicon, PWA icons, and the brand tile.)*

---

## Depth, shape, motion

- **Radii — generous, "objects":** controls `0.75rem`, cards `1.25rem`, panels `1.5rem`.
- **Shadows — soft, never crisp:** two layers (close ambient + far diffuse).
  Warm-tinted in light (shadow hue ~40), graphite in dark. This is the
  "paper & objects" feel — explicitly *not* the old flat-crisp SaaS look.
- **Motion — ≤180ms, ease-out `cubic-bezier(.16,1,.3,1)`:** fade+scale for
  overlays/menus, slide-up for toasts, 2–3px hover-lift on cards, subtle press on
  buttons. Transform/opacity only. Always reduced-motion safe.

---

## Voice (UX copy)

Calm, plain, confident, a little editorial. Lowercase product name "canvas-drop".
- Errors: **"Couldn't [action]. Try again."** — never "Something went wrong."
- One verb per action (Duplicate, not Copy/Make a copy/Clone in the UI).
- One vocabulary: canvas · draft · publish · version · primitive.

---

## Do / Don't

**Do:** warm neutrals everywhere; serif for headings + lead; one teal accent in the
app (amber only on marketing); soft depth; generous whitespace; let covers be the colour.
**Don't:** indigo-violet (the SaaS default); pure white or pure black; cool grey chrome;
gradient-on-everything; serif on controls/data; accent as decoration; hard crisp shadows;
state-by-colour-alone.
