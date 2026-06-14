---
target: canvas-drop dashboard (key screens)
total_score: 30
p0_count: 0
p1_count: 0
timestamp: 2026-06-14T13-57-42Z
slug: apps-dashboard-src-key-screens
---
# Critique — canvas-drop dashboard (key screens)

Target: home (canvas list), canvas overview, editor, admin, create/new — the core authenticated dashboard, post token-evolution.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Strong: skeletons, "Autosaves to draft", "All changes published", toasts, active states. |
| 2 | Match System / Real World | 3 | Plain, exact copy; mono identifiers. "Primitives/canvas" is domain jargon but explained. |
| 3 | User Control and Freedom | 3 | Back links, archive-not-delete, version "Restore to draft", cancel paths. |
| 4 | Consistency and Standards | 4 | Cohesive token system + shared component vocabulary across every screen. |
| 5 | Error Prevention | 3 | Autosave drafts, hold-to-confirm destructive actions, smart defaults, confirm dialogs. |
| 6 | Recognition Rather Than Recall | 3 | Labeled nav, breadcrumbs, visible options; icons mostly paired with text. |
| 7 | Flexibility and Efficiency | 2 | No keyboard shortcuts / command palette; no bulk actions in list or admin. |
| 8 | Aesthetic and Minimalist Design | 4 | Post-evolution: crisp, restrained, every element earns its place. |
| 9 | Error Recovery | 3 | Clear messages + recovery links ("Canvas not found" → Back); now fails fast on 404. |
| 10 | Help and Documentation | 2 | Good inline/onboarding help, but no in-app searchable help or docs entry point. |
| **Total** | | **30/40** | **Good** |

## Anti-Patterns Verdict

**Not AI slop.** This reads as a deliberately built product UI, not a generated template.

- **LLM assessment:** The evolved system avoids every common tell — no gradient text, no glassmorphism, no tracked eyebrows on every section, no hero-metric card grid (the admin stats are now a unified divided strip), no identical-card sprawl. Restraint reads as confidence; the indigo-violet accent is distinctive without shouting. Composition varies meaningfully by screen (3-pane editor vs meta-grid overview vs governance table).
- **Deterministic scan:** 1 finding — `apps/dashboard/src/components/HoldButton.tsx:102` animates `width` (layout thrash; `transition: width`). No other antipatterns across routes + components. Clean.
- **Visual overlays:** Not injected (avoided mutating the running app); grounded instead in full-screen screenshot inspection of every key screen in light + dark + mobile.

## Overall Impression

A genuinely good, trustworthy tool that now looks the part — the dashboard credibly delivers on its "proof of taste" mandate. What works is the system-level discipline: one vocabulary, applied everywhere, in two well-tuned themes. The single biggest opportunity is **efficiency for repeat users** — it looks like Linear but doesn't yet *move* like Linear (no shortcuts, no command palette, no bulk actions). That's the gap between "looks excellent" and "feels excellent in daily use."

## What's Working

1. **System coherence (the strongest asset).** Panels, inputs, toggles, badges, tabs, the TOC rail, empty states, and buttons share one token-driven vocabulary across all 13 screens. Nothing feels stitched together — this is why it scores 4 on Consistency and Aesthetic.
2. **Responsive behavior is structural, not fluid.** The editor collapses its 3-pane IDE into a single column with a Files/Code/Preview/Page switcher; the admin stat strip reflows to a clean 2-col bordered grid. Real breakpoint design, not shrink-to-fit.
3. **Empty states teach.** "Nothing archived," "No backend usage yet → turn on Backend," gallery's "share a canvas and flip List in the gallery" — each names the next action instead of dead-ending.

## Priority Issues

- **[P2] No power-user accelerators.** No keyboard shortcuts, no command palette (⌘K), no bulk actions in the canvas list or admin table.
  - **Why it matters:** The product explicitly aspires to Linear. Repeat users (the core audience deploys/updates canvases constantly) hit a ceiling — every action is point-and-click. This is the gap holding heuristic #7 at 2.
  - **Fix:** Add ⌘K command palette (navigate canvases, create, deploy, jump to settings) and shortcuts for the editor (⌘S → publish draft) at minimum; multi-select + bulk archive/disable in admin.
  - **Suggested command:** `/impeccable shape` (it's a feature, not a restyle).

- **[P2] Help/documentation has no in-app home.** Inline hints and the onboarding snippet are good, but there's no persistent, searchable help or docs link once a user is past onboarding.
  - **Why it matters:** Self-hosters evaluating the tool and first-timers have nowhere to go when stuck mid-task; holds heuristic #10 at 2.
  - **Fix:** A help affordance in the user menu (docs link + keyboard-shortcut cheatsheet), and contextual "?" popovers on the denser surfaces (Capabilities, Protection, admin quotas).
  - **Suggested command:** `/impeccable onboard` (contextual teaching) or `/impeccable clarify`.

- **[P2] HoldButton animates `width` (detector).** `transition: width` on the hold-to-confirm fill causes layout thrash.
  - **Why it matters:** Janky fill on the exact interaction meant to feel deliberate and reassuring (destructive confirms).
  - **Fix:** Animate `transform: scaleX()` with `transform-origin: left` instead, or a `clip-path` inset.
  - **Suggested command:** `/impeccable optimize`.

- **[P3] Canvas-detail navigation is at the working-memory edge.** 6 tabs (Overview/Edit/Versions/Settings/Capabilities/Usage) plus a 6-item Settings sub-nav; on mobile the tab row truncates the last tab ("Us…") with no obvious scroll affordance.
  - **Why it matters:** 6 is the upper bound of comfortable scanning; the silent truncation hides "Usage" on phones.
  - **Fix:** Consider grouping (e.g. fold Versions+Usage under a menu, or merge Capabilities into Settings) and add a scroll-edge fade/affordance on the mobile tab row.
  - **Suggested command:** `/impeccable layout` or `/impeccable distill`.

## Persona Red Flags

**Alex (Power User):** No ⌘K, no visible shortcuts anywhere; editor requires mouse to publish; admin governance is one-row-at-a-time (no multi-select to disable several canvases). Will feel the tool is slower than it looks.

**Sam (Accessibility):** Strong baseline — always-visible accent focus ring, semantic toggles (`role="switch"`), reduced-motion path, AA-tuned contrast (incl. the just-fixed warning-text amber). Watch items: status currently pairs color + dot/label (good — don't regress); verify the CodeMirror editor and the horizontally-scrolling tab row are fully keyboard-traversable and screen-reader announced.

**Casey (Self-hoster / evaluator — project persona):** Lands on a polished, fast, dark-or-light dashboard — trust signal is high. But with no in-app docs/shortcut reference, an evaluator probing "what can this do" has to leave for the repo. The onboarding snippet helps once; nothing persists it.

## Minor Observations

- Mobile canvas-detail tab row truncates the final tab without a scroll hint.
- Overview/usage data now uses tabular numerals (good); ensure the same on any future tables for column alignment.
- The `/canvases/<slug>` URL only accepts the internal UUID; a slug now fails fast (fixed) but doesn't resolve — a slug-aware redirect would match the mental model since slugs are the human identifier everywhere else.
- Onboarding's three method cards border on a uniform grid; they're justified (3 real, parallel choices) but are the closest thing to a card-grid tell on the site.

## Questions to Consider

- What would canvas-drop feel like if every primary action had a keyboard path — could the whole deploy→verify→rollback loop happen without the mouse?
- Does the canvas-detail surface need six peer tabs, or are two of them (Usage, Versions) secondary enough to demote?
- Where should a returning user go when they're stuck — and is "back to the GitHub repo" an acceptable answer for a tool whose own polish is the sales pitch?
