# Plan — Themable design language ("design skins") + editor polish app-wide

- **Status:** in progress (autonomous round)
- **Date:** 2026-06-20
- **Branch:** `claude/gifted-galileo-ayewms` (single branch, one commit per unit)
- **Origin:** Owner experiments (Claude Design handoff, `Editor experience redesign`) explored
  three look-and-feels of the editor + marketing — **Studio / Workshop / Canvas** — each
  flipping a *bundle* of tokens (accent, display font + weight + tracking, radius) via a
  `data-dir` attribute. Owner ask: make the whole design language **admin-flippable** (skins),
  keep today's look as one skin, add the three from the prototype, and **apply the editor's
  polish across the app**.

## Goal

Add an **expression layer** ("design skins") between the existing System and Brand token
layers. A skin is a *named, partial override* of brand tokens — accent family, a display-type
bundle, and a radius scale — selectable instance-wide by an admin. Today's look ("Editorial
Creator OS", teal serif) becomes the default skin `editorial`; the prototype adds `studio`
(terracotta serif), `workshop` (green mono, tighter), and `canvas` (violet bold-sans, rounder).
Every surface (dashboard SPA, editor, server-rendered landing/error/legal) honors the active
skin. Ship the editor polish that doubles as the skin mechanism: **brand-tokenized syntax
highlighting** (theme-aware), the **display-type bundle**, and the preview **live-status** chrome.

## Non-goals (explicit)

- **No structural layout forks.** Skins are *token-only* (DESIGN.md "character through tokens").
  The prototype's IDE activity-bar / brutalist offset-shadows are deferred; we change accent,
  display font/weight/tracking, and radius scale over the **one** existing component structure.
- **No per-user skin switching.** Skin is an **instance/admin** setting (config registry), not a
  per-account preference. (Light/dark stays the per-user axis; skins are orthogonal.)
- **No new fonts.** All three display fonts (Newsreader, Geist, Geist Mono) are already
  self-hosted (`@fontsource-variable/*`) — org-agnostic, no phone-home.

## Architecture — three layers

```
System layer   (radii geometry, easing, shadow geometry, type scale, spacing)   ← untouched
Expression layer (NEW): [data-skin] partial overrides — accent, display, radius  ← this plan
Brand layer    (BRAND_TOKENS, one ramp) → becomes the default skin `editorial`   ← unchanged values
```

- Base `:root` keeps the editorial ramp (unchanged) + new defaults (`--font-display` = serif,
  `--display-weight: 500`, `--display-tracking: -0.02em`, `--radius-scale: 1`) + `--syn-*`.
- Skins are emitted as `:root[data-skin="studio|workshop|canvas"]` blocks overriding the
  accent family (`--accent`, `--accent-hover`, `--accent-fg`, `--accent-subtle`, `--ring`),
  the display bundle, and `--radius-scale`. Dark values come from skin-specific dark blocks
  under both dark selectors (`@media prefers-color-scheme:dark :root[data-skin=…]:not([data-theme=light])`
  and `:root[data-skin=…][data-theme=dark]`).
- **Syntax tokens are theme-dependent, skin-independent** (as in the prototype): `--syn-*` live
  in base `:root` (light) + the two dark blocks only.
- **Radius** is scaled by one multiplier: each `--radius-*` becomes
  `calc(<base> * var(--radius-scale, 1))`; a skin sets `--radius-scale` (scale=1 ⇒ identical).
- The canonical source is `packages/shared/src/brand/skins.ts`; the hand-authored `tokens.css`
  is kept in lockstep by an extended **parity test** (the established pattern), and the anti-
  indigo scan (hue 270–279) must stay green — so `canvas` lives at violet-magenta (~292).

## The skins

| skin | accent (light) | display font | weight | radius scale | feel |
|---|---|---|---|---|---|
| `editorial` *(default)* | deep teal (h200) | Newsreader serif | 500 | 1.0 | today's calm publishing OS |
| `studio` | terracotta (h42) | Newsreader serif | 500 | 1.0 | warm editorial |
| `workshop` | green-teal (h165) | Geist **Mono** | 500 | 0.62 | developer / IDE |
| `canvas` | violet-magenta (h292) | Geist (heavy) | 800 | 1.3 | playful / bold |

## Units (dependency order; one branch, one commit each; gates green per unit)

- **U1 — Skin model (shared).** `packages/shared/src/brand/skins.ts`: `SkinName`, `SKINS`
  (4 skins: label, description, `display{family,weight,tracking}`, `radiusScale`, `light`/`dark`
  accent family), shared `SYNTAX_TOKENS` (light/dark), and generators (`skinAccentVars`,
  `syntaxVars`, role lists). Export from `index.ts`. *Tests:* every skin complete; no hue
  270–279 / no `27[0-9]` run in any value; `editorial` accent === `BRAND_TOKENS` accent;
  lightness sanity bounds (AA-ish).
- **U2 — tokens.css skins + parity.** Add base defaults (`--font-display`, `--display-weight`,
  `--display-tracking`, `--radius-scale`, `--syn-*` light), dark `--syn-*` to both dark blocks,
  wrap `--radius-*` in `calc(... * var(--radius-scale))`, add `[data-skin]` light + dark blocks,
  register a `font-display` utility via `@theme inline`. Extend `tokens.test.ts` to assert skin
  blocks + syntax blocks match `skins.ts`, keep the INDIGO scan. *Deps: U1.*
- **U3 — Editor syntax via tokens.** `CodeEditor.tsx`: a `HighlightStyle` mapping Lezer tags →
  `var(--syn-*)`, replacing `defaultHighlightStyle`. *Tests:* highlight-style mapping covers the
  core tag set; editor still renders. *Deps: U2.*
- **U4 — Display-type on headings.** Route the centralized display titles (`PageHeader` h1; the
  landing hero/section headings) to `font-display` + `var(--display-weight)` +
  `var(--display-tracking)`. Defaults make `editorial` pixel-identical. *Deps: U2.*
- **U5 — Live preview polish.** `DraftPreview` running state gains a "live" status pill
  (pulsing dot, reduced-motion safe) + a bottom URL ribbon with "Open full ↗". *Tests:* pill +
  ribbon render once running; reduced-motion path. *Deps: none (independent).* 
- **U6 — Config + server surfaces.** `env.ts` `designSkin` enum (`CANVAS_DROP_DESIGN_SKIN`,
  default `editorial`); `config-fields.ts` editable `core.designSkin`; thread `designSkin`
  through `meRoutes` (app.ts) + `/api/me`; landing/error/legal server CSS get the skin blocks +
  `data-skin` from config. *Tests:* config default + enum validation; `/api/me` carries
  `designSkin`; landing HTML carries `data-skin` + skin CSS. *Deps: U1.*
- **U7 — SPA applies skin + admin select.** `SkinProvider` reads `useMe().designSkin` → sets
  `document.documentElement.dataset.skin` + persists to localStorage; pre-paint script in
  `index.html` reads localStorage (no FOUC on return visits). Admin `EditableRow` renders a
  `<select>` for `type==="enum"` fields (the only missing piece — server already serializes
  `enumValues`). *Tests:* provider sets the attribute from `me`; enum field renders a select and
  saves. *Deps: U6.*

## Risks / calibration

- **AA contrast doubles per skin × theme.** Accent lightness kept conservative (≈0.49–0.56 in
  light) so `accent-fg` (near-white) clears AA on the fill; final visual audit advisable. Not a
  §12 invariant surface — this is presentation, so right-size review here.
- **Parity discipline.** Skins must be in the parity test or they drift (same guard as the ramp).
- **No destructive migration.** Pure presentation + one additive config field; no schema change.
- **Default unchanged.** `editorial` reproduces today's values exactly — the round must be a
  no-op visually until an admin picks another skin.

## Done = 

All 7 units merged on one branch, `pnpm lint && typecheck && test` green on **both** dialects,
`/ce-code-review` run + findings fixed, CI matrix green on the PR. Owner reviews the PR
(no auto-merge — owner said "I'll check the PR").
