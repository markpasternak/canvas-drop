# Rebrand & Look-and-Feel Readiness — Findings & Proposals

**Date:** 2026-06-17
**Subject:** Making canvas-drop easy to rebrand / reskin / re-voice, plus the concrete polish wins toward a better-looking, smoother app.
**Source:** Synthesis of 7 verified analysis lenses (reskinnability/tokens, component architecture, UX heuristics/flows, visual polish, brand seams, copy & voice, a11y/responsive). Every finding below was opened and confirmed in current `main` source; severities are right-sized to the trusted-org self-host trust model.

This document is meant to be read and then talked through. Sections 6 and 7 are the discussion agenda.

---

## 1. Executive summary

canvas-drop is **most of the way to reskinnable, not all the way.** The dashboard is genuinely token-first (OKLCH semantic vars in `tokens.css` + `@theme inline`), it has a real primitive layer (`Surface.tsx` scaffolds, `Button`, `Field`, `Dialog`, `ActionMenu`), a written design language (`DESIGN.md`), and two clean copy seams already prove the team knows how to build a swappable brand layer (`SITE`/`OPERATOR` for marketing/legal copy). That is a strong base.

What blocks a *clean, one-edit* rebrand is that **the visual + name identity has no single owner, so it has already forked.** The accent color exists as two live hues in production — violet on the SPA/landing, blue on every server-rendered surface (error/legal/docs), the favicon, the PWA icons, and the browser tab — because the ramp is hand-maintained in four places with no parity test (and a test actually pins the blue as canonical). The product name is hardcoded in 12+ spots with the PWA manifest spelling it differently again. And there is no centralized copy module, so re-voicing means editing literals across ~16 routes and ~44 components.

Net: the **token *mechanism* is good; the token *architecture* (brand-vs-system layering, single source feeding every surface) is missing.** Close the four brand/token consolidation gaps and the rest is polish. The same consolidation work that makes a rebrand a one-file edit also fixes the live brand inconsistencies shipping today, so this round pays for itself before any new brand even arrives.

---

## 2. The big picture — what makes a clean rebrand easy

Seven cross-cutting workstreams. The first four are the rebrand-readiness core; the last three are the look-and-feel/quality payload that rides along.

### W1 — Brand layer extraction (the headline)
**Problem:** There is no single owner for color, name, logo, fonts, or meta. Identity values are inlined and duplicated, so they have drifted — the accent is two hues, the name is spelled two ways, the favicon shows the old blue while the app shows violet. `SITE`/`OPERATOR` prove the seam pattern works but were only applied to long-form copy.
**Target end-state:** A small `BRAND` layer in `packages/shared` owns name, wordmark, accent hue, logo colors, theme-color, font stack, and the logo SVG path-data. A `BRAND_TOKENS` object is the single canonical ramp that `tokens.css` and every server renderer consume. The icon generator and `index.html` read from it. A `REBRAND.md` enumerates every seam. After this, a second brand drops in by editing one layer.
**Rolls up:** the accent fork (×3 lens hits), the four-copy ramp, the name-not-a-constant findings (×3), the forked logo sources, orphan accent pages, the manifest spelling mismatch, "no brand layer / no REBRAND map", identity-string documentation.

### W2 — Token system completeness
**Problem:** The token mechanism is good but incomplete. There is no type scale (~28 inline arbitrary font sizes, with a px/rem split for the same size), the shadow scale exists as vars but isn't registered as utilities (27 passthroughs + 3 one-off raw shadows), there is no spacing/control-height scale, and the dark ramp is maintained twice with a real accent/ring mismatch between OS-dark and toggled-dark.
**Target end-state:** `@theme inline` registers `--text-*`, `--shadow-*`, a control-height scale, and the shared content width. The dark ramp is declared once and shared by both selectors. Every arbitrary literal collapses to a utility. Then type rhythm, elevation, and density are each a one-knob change.
**Rolls up:** type-scale (×2), shadow-scale-not-registered + the three raw shadows (×3), dual-dark divergence (×3), control-height drift, spacing/content-width, brand-vs-system layering, parity test.

### W3 — Shared layout scaffolds & primitive consolidation
**Problem:** Core UI concepts are hand-rolled multiple times with diverging looks: the segmented control (4-5 copies, 4 different active treatments, 3 ARIA conventions), tab nav (2 implementations, 2 paddings, 2 active mechanics), the search input (5 copies, off the `Field` recipe), the input `control` string (3+ copies), admin tables (2 byte-identical + a third grid list), the "Clear filters" text button, the tag chip, the code-display box. Prop vocabulary disagrees (`variant` vs `tone` vs boolean).
**Target end-state:** A `SegmentedControl`, `TabNav`, `SearchInput`, `DataTable`, `TextButton`, `Tag`, and `CodeBox` primitive; one shared `inputControl` string; one shared `Variant`/`Tone`/`Size` vocabulary. Restyling a concept is then one file.
**Rolls up:** segmented control (×3), tab nav, search input, input control string, data table, clear button, variant/tone vocabulary, tag chip, code box, share/admin allowlist forms.

### W4 — Copy centralization & voice normalization
**Problem:** No copy module — every UI string is an inline literal, so re-voicing is a repo-wide grep. Voice has drifted: generic "Something went wrong" strings violate the app's own anti-generic rule; one action is named three ways ("Make a copy"/"Duplicate"/"Copy"); the primitives are described three ways; versions read "v3" vs "version 3"; "Backend"/"Capabilities" contradict inside one toggle's own helper.
**Target end-state:** A `lib/copy.ts` (or per-domain `copy/*.ts`) owns toasts, confirm dialogs, empty states, and button labels, extending the existing good maps (`HINTS`, `RUNGS`, `Badge` maps). One verb per action, one primitive vocabulary, one version format.
**Rolls up:** no copy module, name-hardcoded (copy lens), Backend/Capabilities contradiction, clone/duplicate naming, primitive descriptions, version labels, generic errors, Retry vs Try again, exception leakage, pluralization helper.

### W5 — Polish & motion pass ("expensive feel")
**Problem:** Every transient surface hard-cuts in — no entrance/exit motion on Dialog, dropdown, Toast, or mobile menu (zero `@keyframes` in the app), which is the textbook "template" tell against the Linear reference. Plus hover-model inconsistency (cards lift, rows tint), the focus-ring squaring corners, and off-token decorative covers.
**Target end-state:** A small keyframe set (fade+scale for overlays, slide-up for toasts) on transform/opacity only, reusing the existing `--ease-out` token and reduced-motion block. One physical hover model for "a canvas". Focus ring follows each control's radius.
**Rolls up:** no motion anywhere, dialog scrim snap, toast vanish, hover inconsistency, focus-ring radius, generative cover (also W1).

### W6 — A11y baseline
**Problem:** Real AA failures and missing semantics: `--subtle` text fails WCAG AA on the backgrounds it's used on everywhere (4.0–4.4:1); segmented controls expose selection by color alone (no `aria-pressed`) — including the *only* mobile pane switcher; the scope toggle declares tab roles it doesn't implement; reduced-motion kills the HoldButton progress feedback and freezes loading spinners; the mobile menu isn't focus-trapped/escapable.
**Target end-state:** `--subtle` clears 4.5:1 (one token edit); segmented/tab primitives bake in correct ARIA once; reduced-motion preserves essential feedback; mobile menu gets Escape + focus management.
**Rolls up:** subtle contrast, segmented-control ARIA, scope-toggle roles, dual-dark contrast, touch targets, toast live-region, reduced-motion spinner/HoldButton, mobile menu trap, Dialog close affordance.

### W7 — Flow & efficiency upgrades (the daily-use gap)
**Problem:** No command palette or keyboard shortcuts (only ⌘S); seven peer tabs on canvas detail that clip silently on mobile; pasted slugs 404 in the dashboard; JS-canvas editor preview is hard-gated off.
**Target end-state:** ⌘K palette + ⌘↵ publish; tab overflow handled (fade or "More"); slug-aware detail lookup; in-editor preview for scripted drafts.
**Rolls up:** command palette, seven tabs, slug resolution, editor preview gate, shortcut cheatsheet.

---

## 3. Proposed target architecture

The shape to adopt so reskins and main-concept changes are config-level, not code-level.

### 3.1 Two-layer token architecture (brand vs system)
```
packages/shared/src/brand/
  brand.ts          # BRAND: { name, wordmark, accentHue, logoFrame, logoDrop,
                    #          themeColor, fontSans, githubUrl }
  tokens.ts         # BRAND_TOKENS: the ONE canonical OKLCH ramp (light + dark),
                    #   derives accent/hover/subtle/ring from BRAND.accentHue
  logo.ts           # the SVG path-data string (one source)
```
- **System layer** = the graphite neutral ramp, radii, ease, shadow geometry — stays as-is, brand-independent.
- **Brand layer** = one accent hue + logo colors + font + name. Hover/subtle/ring are *derived* in OKLCH off the single hue (adjust L/C), not re-authored.
- `apps/dashboard/src/styles/tokens.css` consumes `BRAND_TOKENS` (build-time inject or a generated CSS string). The dark ramp is declared **once** and shared by `[data-theme="dark"]` and the `prefers-color-scheme` selector.
- Every server renderer (`landing-page`, `error-pages`, `legal-pages`, `docs/render`, `guest-routes`, `social-preview`) imports `BRAND_TOKENS` instead of re-inlining hex.
- A **parity test** (modeled on the sacred dual-dialect schema-parity test) asserts every surface's token map equals the canonical ramp, failing CI on drift — the guard that prevents the next fork.

### 3.2 Type / shadow / size scales registered as first-class utilities
Register in `@theme inline`: `--text-2xs … --text-h1` (mapped to the `DESIGN.md` steps), `--shadow-xs … --shadow-lg`, `--control-sm/md/lg` heights, `--content-max`. Bulk-replace the ~28 font-size literals, the 27 shadow passthroughs + 3 raw shadows, and the h-8/h-9/h-10 drift. Density and type rhythm become one-token changes.

### 3.3 Primitive + layout-scaffold set
Keep the well-factored `Surface.tsx` family (`PageHeader`/`Panel`/`InlineNotice`/`MetaGrid`/`ActionRow`) as the model and extend it:
- **New primitives:** `SegmentedControl`, `TabNav`, `SearchInput`, `DataTable`, `TextButton` (or `Button variant="link"`), `Tag`, `CodeBox`, a shared "add-by-value" inline form.
- **Shared strings:** one `inputControl` constant (+ `searchInput` variant) consumed by `Field`, `SlugField`, `PasswordField`, `SearchInput`, allowlist panels.
- **One vocabulary:** a single `Variant`/`Tone` union + `Size` scale module imported by `Button`, `IconButton`, `Badge`, `InlineNotice`, `ActionMenuItem`. Standardize on `variant`.
- ARIA baked into the primitives once (`aria-pressed` on segments, `aria-current`/`activeProps` on tabs, focus management in overlays).

### 3.4 Brand assets & strings ownership
- Logo SVG path-data exported once, consumed by `Brand.tsx` + server `brand.ts`; the three static `public/` masters and `generate-brand-icons.mjs` derive frame/drop/background from `BRAND_TOKENS` so re-running `pnpm brand:icons` after a recolor yields on-brand icons automatically.
- `index.html` + `site.webmanifest` get name + theme-color via a Vite define / build-time replace.
- `REBRAND.md` enumerates: `BRAND`, `BRAND_TOKENS`, the SVG source, the `public/` masters + generator, `SITE`/`OPERATOR`, the og image, and the identity-string list (cookies/storage keys/SDK global — "change only for a hard fork").

### 3.5 Copy organization
`lib/copy.ts` (or per-domain `copy/*.ts`) grouping toasts, confirm dialogs, empty states, button labels, plus a `versionLabel(n)` and `count(n, noun)` helper. Fold the existing `HINTS`/`RUNGS`/`Badge` maps in. A `PRIMITIVES` map (`{kv:{label,blurb,api}, …}`) is the single source for the four-primitive vocabulary across UI + docs. `BRAND.name` referenced from all copy.

---

## 4. Findings table

Deduped across lenses. Sorted blocks-rebrand → high → medium → low → polish within each workstream. Effort S/M/L.

### W1 — Brand layer extraction
| # | Finding | Sev | Eff | Conf | Evidence | Proposal |
|---|---|---|---|---|---|---|
| 1.1 | **Accent forked into two live hues across 8+ surfaces; a test pins the blue as canonical** | blocks | M–L | high | SPA/landing violet hue 274 (`tokens.css:36`, `landing-page.ts:246`) vs blue `#2563eb`/`#60a5fa` on `error-pages.ts:100,118` (also feeds `docs/render.ts`), `legal-pages.ts:84`, `favicon.svg:6`, `brand/*.svg:6`, `generate-brand-icons.mjs:11-12`, `site.webmanifest:24`, `index.html:9`. `password-gate.test.ts:145` asserts `#2563eb` canonical; `:147` only forbids the older `#6366f1`. Landing comment: "HAND-MAINTAINED FORK … nothing fails if they drift" (`landing-page.ts:230-235`). | One canonical OKLCH ramp in `packages/shared`; every surface derives from it; convert to hex for hex-only surfaces; regenerate icons; rewrite the test to assert the shared constant. |
| 1.2 | **Four hand-maintained ramp copies with no parity guard** | blocks→high | L | high | `tokens.css:25-66`, `landing-page.ts:238-280`, `error-pages.ts:90-127`, `legal-pages.ts:78-86`. No `packages/shared` brand/tokens module. | Extract `BRAND_TOKENS` to `packages/shared`; all consume it. Until then, add a parity test (schema-parity model) failing CI on divergence. |
| 1.3 | **No brand layer / no REBRAND map; the good seam (SITE/OPERATOR) isn't mirrored for color/logo/name** | high | L | high | `SITE` (`landing-page.ts:39-56`) + `OPERATOR` (`legal-pages.ts:25-31`) are clean seams; no equivalent for visual identity; no brand module; no `REBRAND.md`. | Establish `BRAND` + `BRAND_TOKENS` + SVG source in `packages/shared`; write `REBRAND.md`. |
| 1.4 | **Product name hardcoded 12+ places; PWA manifest spells it "Canvasdrop"** | high | M | high | `app-layout.tsx:122,127`, `UserMenu.tsx:112`, `ErrorState.tsx:35`, `Brand.tsx:11`, `new.tsx:43,201`, `onboarding.tsx:7`, `index.html:7,8,14,24,25,34`, `social-meta.ts:50,57`, `social-preview.ts:38,40,186`, `docs/render.ts:241-242`. `site.webmanifest:2-3` + `brand/canvasdrop-logo.svg:22` say "Canvasdrop". | `BRAND.name` in `packages/shared`; wire into SPA, server meta, `SITE`/`OPERATOR`; Vite-inject `index.html`/manifest; fix the spelling. |
| 1.5 | **Logo geometry + colors live in 6 unsynced sources; PNG icons bake legacy blue** | high→med | M | high | Path-data duplicated `Brand.tsx:25-44` + `brand.ts:7-11`; static masters use different vars (`--frame/--drop`) + hardcode hex (`favicon.svg:5-6`, `brand/*.svg:5-6`); `generate-brand-icons.mjs:11-12,26` bakes blue + non-token bg. | One SVG source + colors from `BRAND_TOKENS`; generator + masters derive from canonical. |
| 1.6 | **Orphan accent `#5b8cff` + one-off inline colors on guest interstitial / social-preview** | med | S | high | `guest-routes.ts:44-46` (`#0b0b0c`/`#5b8cff`, system font); `social-preview.ts:201-202` (`#0b0b0d`/`#60a5fa`). | Route through shared token block; replace with canonical accent + Geist. |
| 1.7 | **Webmanifest + logo SVG wordmark spelling/casing disagree with the app** | med | S | high | `site.webmanifest:2-3` + `canvasdrop-logo.svg:22` "Canvasdrop" vs "canvas-drop" everywhere. | Align to `BRAND.name`; treat the logo SVG text as generated. |
| 1.8 | **App-identity strings in storage keys / cookies / URL paths / SDK global (document, don't churn)** | low | S | high | `theme.tsx:6`, `session.ts:10`/`guest.ts:10`/`oidc.ts:15` (`__canvasdrop_`), `CanvasCover.tsx:16`, SDK global `canvasdrop` (`browser-entry.ts:14`), `cd_secret_key` (`onboarding.tsx:12,16`), MCP scope (`routes.ts:94-95`). | Leave values (changing is breaking); document in `REBRAND.md`; optionally centralize prefixes. |

### W2 — Token system completeness
| # | Finding | Sev | Eff | Conf | Evidence | Proposal |
|---|---|---|---|---|---|---|
| 2.1 | **No type scale — ~28 inline font sizes; px/rem split for the same 11px** | high | M | high | `tokens.css` `@theme` registers no `--text-*`; `text-[0.8125rem]` ×11, `text-[0.6875rem]` ×8, `admin.settings.tsx:91,127` use raw `text-[11px]`. | Register `--text-*` mapped to `DESIGN.md` steps; bulk-replace; normalize the px sites. |
| 2.2 | **Dark ramp maintained twice with a real accent/ring mismatch (OS-dark vs toggled-dark)** | high | S | high | `tokens.css:85` accent `oklch(0.685 0.18 274)` vs `:132` `oklch(0.72 0.155 274)`; `--ring`/`--accent-hover`/`--logo-drop`/`--shadow-focus` also differ (`:100/:147`, `:86/:133`, etc.). Contrast differs 6.53:1 vs 7.45:1. | Declare the dark ramp once, shared by both selectors; one canonical accent. |
| 2.3 | **Shadow scale exists as vars but isn't a utility — 27 passthroughs + 3 raw one-off shadows** | med | M | high | `tokens.css:57-65` vars not in `@theme`; `shadow-[var(--shadow-*)]` ×27; raw `0_1px_3px hsl(...)` at `app-layout.tsx:52,83` + `new.tsx:238` (`DESIGN.md:119` says these should be `--shadow-xs`). | Register `--shadow-*` in `@theme`; bulk-replace; fold the three raw shadows into a scale step. |
| 2.4 | **No control-height scale — h-8/h-9/h-10 drift across shared rows** | low | M | high | `Button.tsx:27-28`, `HoldButton.tsx:90` (h-8), `PublishBar.tsx:169,192` (h-8/h-9), `index.tsx:295,305,585`, `app-layout.tsx:146,161`, `UserMenu.tsx:65` (h-9). | Define `--control-sm/md/lg`; primitives consume via a `size` union. |
| 2.5 | **No spacing scale; shared content width inlined twice** | low | S | high | `max-w-[112rem]` at `app-layout.tsx:103,195`; no `--space-*`. | Promote content width to one `--content-max` token; leave the rest on Tailwind defaults. |
| 2.6 | **Theme applied post-mount (FOUC); server pages ignore the saved theme choice** | low | S | med | `theme.tsx:32-34` useEffect; `index.html` has no pre-paint bootstrap; `docs/render.ts:36-40` declares `[data-theme]` but never sets it. | Inline a `data-theme` bootstrap in `index.html`; optionally propagate via cookie to server pages. |

### W3 — Shared layout scaffolds & primitives
| # | Finding | Sev | Eff | Conf | Evidence | Proposal |
|---|---|---|---|---|---|---|
| 3.1 | **Segmented/toggle control hand-rolled 4-5×, 4 active treatments, 3 ARIA conventions** | high | M | high | `app-layout.tsx:50-53` (ThemeSwitch, aria-pressed), `:87-98` (section nav, aria-current), `PublishBar.tsx:169-172,193-194` (ModeButton/PaneButton, `active` prop), `DeployButton.tsx:82,93-96`, `index.tsx:291-309` (ScopeToggle, role=tablist), `new.tsx:226-258`. | One `SegmentedControl` primitive; one active treatment; bake `aria-pressed`/roles in once; migrate all sites. |
| 3.2 | **Search input hand-rolled in 5 routes, off the Field recipe** | high | M | high | Byte-identical at `index.tsx:579-585`, `admin.canvases.tsx:151-157`, `gallery.tsx:294-300`, `admin.users.tsx:97-102`, `admin.settings.tsx:255-265`; differs from `Field.tsx:5-9`. | `SearchInput` primitive on the shared `inputControl` string. |
| 3.3 | **Input `control` string duplicated across Field/SlugField/PasswordField + ad-hoc copies** | med | S | high | Identical at `Field.tsx:5-9` + `SlugField.tsx:6-10`; near-copy `PasswordField.tsx:97-103`; ad-hoc `AllowedEmailsPanel.tsx:62`. | Export one `inputControl` (+ `searchInput`) constant; all consume it. |
| 3.4 | **Variant axis disagrees (variant vs tone vs boolean); control heights bespoke** | med | M | high | `Button.tsx:4-9` `variant`; `IconButton.tsx:4,12-16` `tone`; `Badge`/`InlineNotice` `tone`; `ActionMenuItem` `danger` bool (`ActionMenu.tsx:218-249`); `FilterChip` h-9, `HoldButton` h-8, `CopyButton` no fixed height. | One shared `Variant`/`Tone` union + `Size` scale; standardize on `variant`; give chips a `size`. |
| 3.5 | **Two admin tables hand-roll byte-identical chrome; no DataTable scaffold** | med | M | high | `AdminCanvasTable.tsx:172-186` ≡ `AdminUserTable.tsx:106-118`; `CanvasList` is a third grid pseudo-table. | `DataTable` scaffold; migrate both; evaluate folding `CanvasList`. |
| 3.6 | **Two divergent tab-nav implementations (2 paddings, 2 active mechanics)** | med | M | high | `AdminHeader.tsx:23-32` (`activeProps`/`aria-current`, py-2) vs `CanvasDetail.tsx:120-137` (imperative `isActive`, py-3). | `TabNav` primitive (prefer `activeProps`); replace both + the app-layout section nav. |
| 3.7 | **"Clear all/Clear filters" ghost button copied with inconsistent label + styling** | med | S | high | Raw at `gallery.tsx:338-343`, `index.tsx:623-629`, `admin.canvases.tsx:186-192`; divergent copy `index.tsx:639-645`; `admin.settings.tsx:263-265` already uses `Button variant="ghost"`. Labels: "Clear all"/"Clear filters"/"Clear owner filter". | `TextButton` (or `Button variant="link"`); standardize "Clear filters". |
| 3.8 | **Tag chip re-implemented (display vs clickable) with no Tag primitive** | low | S | high | `CanvasList.tsx:61-62` vs `gallery.tsx:54-62`. | `Tag` primitive with optional `onClick`/`as`. |
| 3.9 | **Inline code/secret box repeated; AllowedEmailsPanel bypasses Field** | low | S | high | `ApiKeyReveal.tsx:21-24` ≡ `new.tsx:372-375`; `AllowedEmailsPanel.tsx:56-62`. | `CodeBox` primitive; route the panel through `Field`/`inputControl`. |
| 3.10 | **Share + admin allowlist forms are near-identical, likely to drift** | low | M | med | `canvas.share.tsx:479-496,510-517` vs the admin allowed-emails twin. | Shared "add-by-value" inline form; row actions via `TextButton`. |

### W4 — Copy centralization & voice
| # | Finding | Sev | Eff | Conf | Evidence | Proposal |
|---|---|---|---|---|---|---|
| 4.1 | **No centralized copy/strings module — every UI string is an inline literal** | blocks | L | high | No `lib/copy.ts`; inline strings across routes/components; good maps exist only at `api.ts:330-359` (HINTS), `canvas.share.tsx:355-373` (RUNGS), `Badge.tsx:31-72`. | `lib/copy.ts` grouping toasts/confirms/empty-states/buttons; fold the good maps in; migrate highest-churn first. |
| 4.2 | **"Backend" tab vs "Capabilities" — a toggle's own helper points to a tab name that doesn't exist** | high | S | high | Tab/page "Backend" (`CanvasDetail.tsx:32`, `canvas.capabilities.tsx:64`); helper says "change in Capabilities" (`new.tsx:211`); onboarding says "Backend tab" (`onboarding.tsx:19`). | Standardize on "Backend"; fix `new.tsx:211`. |
| 4.3 | **One action, three names: Make a copy / Duplicate canvas / Copy** | med | S | high | `CloneDialog.tsx:23-24,42,45,58`; `canvas.settings.tsx:271,275,445-446`. | One verb ("Duplicate"); keep "clone" in code only; centralize. |
| 4.4 | **Four primitives described three different ways** | med | M | high | `canvas.capabilities.tsx:16-37` vs `new.tsx:211` vs `onboarding.tsx:16-19` vs `canvas.share.tsx:416`. | One `PRIMITIVES` map (label+blurb+api id); source all surfaces from it. |
| 4.5 | **Version labels mix "v3" and "version 3"** | med | S | high | `DeployButton.tsx:61` "Published v3" vs `canvas.editor.tsx:396` "Published version 3"; `canvas.versions.tsx:66,84`. | Standardize "version N"; `versionLabel(n)` helper; vN for badges only. |
| 4.6 | **Generic "Something went wrong"/"failed" violate the app's own anti-generic rule** | med | S | high | `index.tsx:654`, `gallery.tsx:353`, `new.tsx:108`, `DeployButton.tsx:65` vs `EmptyState.tsx:4-5` rule + "Couldn't X" voice. | Rewrite to "Couldn't [action]. Try again."; keep in copy module. |
| 4.7 | **Retry CTA verb inconsistent: mostly "Try again", boundary uses "Retry"** | low | S | high | `index.tsx:656`/`gallery.tsx:355` "Try again" vs `ErrorState.tsx` reset "Retry". | Standardize "Try again"; one constant. |
| 4.8 | **Raw exception/status text can leak into route-error + server fallback** | low | S | med | `ErrorState.tsx` renders `error.message`; `error-pages.ts` `fallbackMessage()` returns `statusText`/`humanizeCode`. | Curated message + raw text only in the detail box; friendly default for unknown codes. |
| 4.9 | **Pluralization helper duplicated inline** | low | S | high | `BulkActionBar.tsx:41-42`, `canvas.editor.tsx:270`; no helper in `lib/format.ts`. | Add `count(n, noun)`/`plural()` to `lib/format.ts`. |
| 4.10 | **Positive: error-hint/access-rung/status-badge copy already well-centralized** | (model) | — | high | `api.ts:330-359`, `canvas.share.tsx:355-373`, `Badge.tsx:31-72`. | Use as the template; migrate inline copy into the same pattern. |

### W5 — Polish & motion
| # | Finding | Sev | Eff | Conf | Evidence | Proposal |
|---|---|---|---|---|---|---|
| 5.1 | **No entrance/exit motion anywhere (Dialog, dropdown, Toast, mobile menu)** | high | M | high | Only `animate-pulse`/`animate-spin` exist; zero `@keyframes`. `Dialog.tsx:74,86-93`, `ActionMenu.tsx:178-194`, `Toast.tsx:21,36-48`, `app-layout.tsx:173-193`. `--ease-out` token + reduced-motion block already exist. | Small keyframe set (fade+scale overlays, slide-up toasts), transform/opacity only, reduced-motion-safe, data-state for exit. |
| 5.2 | **Dialog scrim backdrop-blur snaps on in one frame** | low | S | high | `Dialog.tsx:86` no transition; `:74` returns null when closed. | Fold scrim into the Dialog entrance (#5.1). |
| 5.3 | **Toasts vanish abruptly on a fixed 2.6s timer** | low | S | high | `Toast.tsx:21` setTimeout 2600; `:36-48` no animation. | Slide-up enter + fade-out exit via two-phase removal. |
| 5.4 | **Hover affordance inconsistent: gallery cards lift, owner rows only tint** | low | S | high | `gallery.tsx:23` `hover:-translate-y-0.5`; `CanvasList.tsx:214-216` `transition-colors` only. | One physical model for "a canvas"; codify in `lib/row-styles.ts`. |
| 5.5 | **Global :focus-visible forces border-radius:2px, overriding each control's radius** | low | S | med | `base.css:69-73`; two focus idioms coexist (`ActionMenu.tsx:163,215`, `CanvasList.tsx:255`); `--shadow-focus` unused. | Remove the radius override; standardize on one focus idiom; use `--shadow-focus` if a halo is wanted. |

### W6 — A11y baseline
| # | Finding | Sev | Eff | Conf | Evidence | Proposal |
|---|---|---|---|---|---|---|
| 6.1 | **`--subtle` text fails WCAG AA on canvas/sunken backgrounds where it's used everywhere** | high | S | high | `tokens.css:32`; computed: subtle/canvas 4.33, subtle/surface-sunken 4.05, forced-dark subtle/surface 4.38, /surface-raised 4.05 — all <4.5. Used at `CanvasList.tsx:264,269`, `index.tsx:344,312`, `PublishBar.tsx:85`, `Field.tsx:7`. | Darken light `--subtle`→~`oklch(0.50 …)` (5.47/5.11) and lighten dark→~`oklch(0.62 …)`; re-verify all four bg pairs. |
| 6.2 | **Segmented controls expose selection by color alone (no aria-pressed) — incl. the only mobile pane switcher** | high | S | high | `PublishBar.tsx:159-180,182-203,125` (lg:hidden), `DeployButton.tsx:84-101`. (`new.tsx:229`/`Filters.tsx:79` already correct.) | Add `aria-pressed`, or bake into the `SegmentedControl` primitive. |
| 6.3 | **Scope switcher uses role=tablist/tab without the keyboard model or aria-controls** | med | S | high | `index.tsx:293-315`: roles + aria-selected, no roving tabindex/arrows/tabpanel. | Drop tab roles, treat as a filter button group with `aria-pressed`. |
| 6.4 | **System-dark vs forced-dark accent diverge — contrast not equal across both dark paths** | med | M | high | (dup of 2.2 from a11y angle) `tokens.css:85/132`, `:100/147`, `:112/159`; 6.53:1 vs 7.45:1. | Declare dark ramp once; verify focus-ring + accent-fg contrast on one value. |
| 6.5 | **Icon-only controls default to 32px on mobile flows** | low | S | high | `IconButton.tsx:19,32,38` size-8; `ActionMenu.tsx:163`; `CanvasList.tsx:278` not hidden below lg; `canvas.editor.tsx:537-546`. | Bump to size-9 on coarse pointers (or default size-9 / lg:size-8). |
| 6.6 | **Toast live-region role/aria-live flips reactively, risking missed announcements** | low | S | med | `Toast.tsx:33-34` toggles role/aria-live on one element; 2600ms, no pause/dismiss. | Two always-present sibling live regions; pause on hover; optional dismiss. |
| 6.7 | **Reduced-motion reset freezes spinners (sole sighted busy cue) and kills HoldButton progress** | low–med | S–M | high | `base.css:86-91` `!important` 0.01ms; `Button.tsx:48-50`, `HoldButton.tsx:104-107` (1s sweep collapses; JS timer unaffected). | Reduced-motion text label ("Saving…"); scope hold fill out of the blanket override or use a discrete countdown. |
| 6.8 | **Mobile section menu not focus-trapped or Escape-closable** | low | S | high | `app-layout.tsx:173-193`: no focus move, no Escape, no focus return. | Move focus on open, Escape-to-close with restore (reuse `Dialog.tsx:40,70`). |
| 6.9 | **Base Dialog offers no built-in close (X) — latent shared-seam risk** | polish | S | med | `Dialog.tsx:82-84` backdrop+Escape only; every caller currently adds Cancel. | Optional on-by-default close (X) IconButton in the header. |

### W7 — Flow & efficiency
| # | Finding | Sev | Eff | Conf | Evidence | Proposal |
|---|---|---|---|---|---|---|
| 7.1 | **No command palette or keyboard shortcuts — the Linear-parity efficiency gap** | high | L | high | Zero cmdk/⌘K hits; only ⌘S (`CodeEditor.tsx:114,142-151`); publish/nav/create all mouse-only. | ⌘K palette (navigate/create/jump/deploy) + ⌘↵ publish; discoverable affordance in the top bar. |
| 7.2 | **Canvas detail has grown to SEVEN peer tabs; silent horizontal clip on mobile** | med | M | high | `CanvasDetail.tsx:10-48` (7 tabs), `:116` overflow-x-auto, `:71-77` scrollIntoView, no edge fade; `:69` comment still says "six". | Demote 2 read-mostly tabs behind "More", or add scroll-edge fade (bake into `TabNav`). |
| 7.3 | **Slug URLs 404 in the dashboard — mental-model mismatch** | med | M | high | `api.ts:712` `/api/canvases/${id}`; `owner-guard.ts:21-26` findById only; recovery is 404 (`canvas.tsx:20-32`). | Slug-aware detail lookup → redirect to canonical `/canvases/<uuid>`. |
| 7.4 | **JS-canvas editor inline preview hard-gated off, no in-pane way to verify** | low | L | high | `canvas.editor.tsx:134,141,655`; `DraftPreview.tsx:62,158,163`. | Authenticated same-origin draft frame or "Run preview" for scripted drafts. |
| 7.5 | **No in-app keyboard-shortcut reference or contextual help on dense surfaces** | low | M | med | Docs link + About ship; no cheatsheet; dense Share/Backend/admin-quota carry prose only. | `?` cheatsheet (linked from user menu) + lightweight "?" popovers reusing inline-notice vocab. |

### Cross-workstream (decorative cover — appears in W1/W5/W7)
| # | Finding | Sev | Eff | Conf | Evidence | Proposal |
|---|---|---|---|---|---|---|
| X.1 | **GenerativeCover ignores the brand accent; with screenshots off (default) it's the dominant gallery visual** | low–polish | S–M | high | `GenerativeCover.tsx:27-40` sweeps full hue wheel; fallback in `CanvasCover.tsx:38`; capture pipeline ships OFF. | Derive cover hues from the brand accent ±offset (read hue from token); keep full-spectrum opt-in. |

---

## 5. UX / visual improvement proposals — ranked by impact ÷ effort

Highest leverage first.

1. **Add overlay/toast motion (W5.1).** *M effort, high impact.* The single biggest "clean → expensive" move; the `--ease-out` token and reduced-motion block are already in place, so it's four contained components. Subsumes 5.2/5.3.
2. **Darken `--subtle` to clear AA (W6.1).** *S effort, high impact.* One token edit fixes the most-used meta text across every screen and is itself a reskin asset.
3. **Unify the dark ramp (W2.2/6.4).** *S effort, real visible bug.* Removes a live "accent changes depending on how you reached dark" inconsistency and halves a reskin surface.
4. **One hover model for "a canvas" + fix the focus-ring radius (W5.4/5.5).** *S effort.* Cheap coherence wins on the two most-seen surfaces.
5. **Register type + shadow scales (W2.1/2.3).** *M effort.* Unlocks one-knob typography/elevation reskins and removes ~55 arbitrary literals.
6. **Tab overflow affordance + demote 2 tabs (W7.2).** *M effort.* Stops the silent mobile clip; pairs with the `TabNav` primitive.
7. **`SegmentedControl` + `aria-pressed` (W3.1/6.2).** *M effort.* Fixes a real mobile-nav a11y gap and 4-way visual drift in one primitive.
8. **Command palette + ⌘↵ publish (W7.1).** *L effort, high daily-use impact.* The "feels excellent in daily use" upgrade; scope decision needed (see §6).
9. **Generative covers on-brand (X.1).** *S–M effort.* With screenshots off by default, this is what makes a reskin read as finished vs half-done.

---

## 6. Open questions / decisions to talk through

1. **Rebrand direction — keep "minimal editorial, sharpened" or go bolder?**
   `DESIGN.md` targets Linear-like restraint. Two installed direction skills offer alternatives: `minimalist-ui` (warm monochrome, typographic, flat bento — *closest to current intent, sharpened*) and `industrial-brutalist-ui` (Swiss/terminal, extreme type contrast — *a genuine identity shift*). **Recommended default:** stay in the minimal-editorial lane and sharpen it; treat the brutalist option as a separate experiment only if you want a deliberately distinct second brand. The architecture work (§3) is direction-agnostic and should land regardless.

2. **Scope — dashboard only, or landing + editor + server pages too?**
   The accent fork lives *because* the server surfaces were excluded. **Recommended default:** scope the **brand/token consolidation (W1/W2) across all surfaces** (that's the whole point), but scope the **polish/primitive/flow work (W3/W5/W7) to the dashboard** first, with the editor as a fast-follow.

3. **How far to push polish vs ship the rebrand seam?**
   **Recommended default:** treat W1+W2+W4-centralization as the rebrand-readiness *gate* (must land), and W5/W6/W7 as a *quality pass* that can ship incrementally after. Don't let motion/flow scope-creep block the brand-layer extraction.

4. **Command palette — in or out of this round?**
   It's the biggest daily-use win but an L. **Recommended default:** out of the core rebrand round, in as the headline of a fast-follow "efficiency" round — but build `TabNav`/navigation primitives now so the palette has clean targets later.

5. **Single source of truth: OKLCH everywhere, or OKLCH + derived hex?**
   Hex-only surfaces (icons, manifest, theme-color) can't take OKLCH. **Recommended default:** author in OKLCH in `BRAND_TOKENS`, derive hex at build time for the hex-only surfaces — one source, no hand-sync.

6. **Copy module shape — one `lib/copy.ts` or per-domain `copy/*.ts`?**
   **Recommended default:** per-domain files (`copy/toasts.ts`, `copy/confirms.ts`, `copy/primitives.ts`) so they stay small and ownable, with a barrel export. Start by migrating toasts + confirm dialogs + empty states.

7. **Generative covers — anchor to brand, or keep full-spectrum as a feature?**
   **Recommended default:** anchor to the accent hue ±offset with an escape-hatch flag; the per-canvas distinctiveness survives via the hash, and reskins stay coherent.

8. **The pinned-blue test (`password-gate.test.ts:145`) — what's canonical?**
   This is a forcing function: whichever hue wins, the test must assert the shared constant, not a literal. **Decision needed up front** because it determines which way the consolidation collapses (recommended: collapse to the violet, the SPA's shipped identity).

---

## 7. Sketch of the eventual plan (phase ordering, not the plan)

Dependency-ordered so the discussion turns cleanly into a runnable plan.

**Phase 0 — Decisions (this conversation).** Resolve §6 Q1/Q2/Q5/Q8 (direction, scope, OKLCH strategy, canonical hue). Everything downstream depends on these.

**Phase 1 — Brand & token foundation (W1 + W2 core).** *Unblocks everything visual.*
- Extract `packages/shared/src/brand/` (`BRAND`, `BRAND_TOKENS`, `logo` path-data).
- Add the **parity test** first (guards while you migrate).
- Point `tokens.css` + every server renderer at `BRAND_TOKENS`; unify the dark ramp; fix the accent fork; regenerate icons from canonical; fix the name + manifest spelling.
- Register `--text-*`, `--shadow-*`, `--control-*`, `--content-max`.
- Write `REBRAND.md`.
- *Lands: one-edit reskin + the live brand inconsistencies fixed.*

**Phase 2 — Primitive consolidation (W3) + the AA/ARIA baseline that rides on it (W6.1/6.2/6.3).**
- `SegmentedControl`, `TabNav`, `SearchInput`, `DataTable`, `TextButton`, `Tag`, `CodeBox`; shared `inputControl` + `Variant`/`Size` vocab.
- Bake `aria-pressed`/roles/focus into the primitives once; darken `--subtle`.
- Migrate call sites onto the primitives (this is where most of the literal bulk-replace lands).

**Phase 3 — Copy centralization (W4).**
- Stand up `copy/*.ts`; migrate toasts → confirms → empty states; add `PRIMITIVES`, `versionLabel`, `count`; fix the Backend/Capabilities + clone/duplicate + version-label inconsistencies; wire `BRAND.name`.
- *Can partly parallelize with Phase 2 once the copy module shape is decided.*

**Phase 4 — Polish & motion pass (W5 + remaining W6).**
- Overlay/toast/menu keyframes; hover model; focus-ring; reduced-motion feedback; mobile-menu trap; Dialog close affordance; on-brand covers.

**Phase 5 — Flow & efficiency (W7) — fast-follow round.**
- Command palette + ⌘↵; tab overflow/demotion; slug-aware lookup; JS-canvas preview; shortcut cheatsheet.

Phases 1→2→3 are the rebrand-readiness spine and should be one or two PRs each (small, merge often). Phases 4–5 are independently shippable quality rounds.
