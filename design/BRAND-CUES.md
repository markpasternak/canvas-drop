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
| canvas | `0.969 0.008 85` | `#f7f4ed` | app/page background — warm paper floor |
| surface | `0.987 0.006 85` | `#fbf9f3` | default card / panel |
| surface-raised | `0.998 0.004 85` | `#fffef9` | headers, raised controls (near-white, faintly warm) |
| surface-sunken | `0.945 0.010 85` | `#efe9dd` | wells: segmented controls, code gutters |
| fg | `0.255 0.012 75` | `#2f2a23` | primary text — warm near-black, never pure `#000` |
| muted | `0.475 0.012 75` | `#6b655b` | secondary text (AA) |
| subtle | `0.500 0.012 75` | `#726c61` | tertiary/meta (AA-tuned — don't go lighter) |
| border | `0.895 0.010 85` | `#e3ddd0` | hairline divider |
| border-strong | `0.820 0.012 75` | `#cabfac` | input borders, secondary-button outline |

### Dark — deep navy (system alternate)
| Role | OKLCH | ~Hex | Use |
|---|---|---|---|
| canvas | `0.175 0.018 265` | `#14161f` | deep navy floor — never pure black |
| surface | `0.212 0.020 265` | `#1b1e29` | default card / panel |
| surface-raised | `0.245 0.022 265` | `#222533` | headers, raised controls |
| fg | `0.965 0.004 265` | `#f3f3f6` | primary text |
| muted | `0.715 0.014 265` | `#a6a8b5` | secondary text |
| subtle | `0.620 0.014 265` | `#8a8c9c` | tertiary/meta (AA-tuned) |
| border | `0.295 0.020 265` | `#30343f` | hairline divider |

### Accent — deep teal (hue ~200), the primary chromatic identity
Deliberately **not** the default SaaS indigo-violet — that hue is now visual
wallpaper (Slack, Twitch, Linear, Heroku, Datadog all share it; it was meant to
escape blue and became the new default). Teal is distinctive, premium, a forecast
2025–26 lead colour, and pops on both warm paper and deep navy.

| Role | Light OKLCH (~hex) | Dark OKLCH (~hex) |
|---|---|---|
| accent | `0.49 0.105 200` (`#0c7b88`) | `0.78 0.105 195` (`#56c9d3`) |
| accent-hover | `0.43 0.10 200` (`#0a6b76`) | `0.83 0.09 195` (`#7fd8df`) |
| accent-fg (text on accent) | `0.99 0.02 200` (`#f3feff`) | `0.16 0.04 210` (`#0a1418`) |
| accent-subtle (badge/selected bg) | `0.93 0.045 197` (`#d6eef0`) | `0.30 0.06 200` (`#1d3940`) |

Used for: primary CTA, current selection, active nav, links, focus ring.
**Keep accent under ~10% of any screen.** Everything else is warm neutral.

### Second accent — warm amber (hue ~72), MARKETING ONLY
The editorial warm-cool counterpoint to teal. Used on **marketing surfaces only**
(drenched hero/CTA, italic emphasis, eyebrows). The **app stays single-accent teal**
so the canvases carry the colour ("quiet chrome, expressive content").
- amber `0.78 0.15 72` (`#e0a23a`) · amber-ink (AA text on paper) `0.52 0.13 60` (`#a8731f`)

### Semantic (state) — always paired with a dot/icon/label, never colour alone
- success `0.52 0.13 152` (`#2c8f5c`) · subtle `0.95 0.04 152`
- warning `0.53 0.14 58` (`#9a6a17`) · subtle `0.95 0.05 80`
- danger  `0.555 0.205 27` (`#cc3a36`) · subtle `0.96 0.022 27`

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
  Warm-tinted in light (shadow hue ~40), deep navy in dark. This is the
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
