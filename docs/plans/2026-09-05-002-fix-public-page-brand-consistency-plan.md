---
title: Consistent public-page branding and navigation
type: fix
status: active
date: 2026-09-05
---

# Consistent public-page branding and navigation

Follow-up to the approved UX release: the docs, Privacy and Terms pages must feel like the same product as the landing page and dashboard. The logo geometry is already shared, but the presentation and navigation have drifted.

- [ ] Share the public header, logo tile, footer, fonts and theme controls between marketing, docs, Privacy and Terms. Respect the active instance skin and saved theme; retain public access and existing login behavior.
- [ ] Remove the docs shell's dependency on error-page layout. Give its sidebar clear current-page states, useful spacing, and a keyboard-operable mobile disclosure with a usable no-JavaScript fallback. Keep search and previous/next navigation working.
- [ ] Give legal documents the same page chrome and a clear Privacy/Terms switch. Preserve the legal text, operator facts and policy dates.
- [ ] Verify desktop/mobile, light/dark, active skins, keyboard navigation, theme persistence and public routes. Add regression tests for navigation behavior and cross-surface brand consistency; run lint, typecheck, full dual-dialect/dashboard tests and build.
- [ ] Review, merge through green CI, deploy the follow-up, and verify the live pages.

No new authorization, backend capability or persistence model is introduced. Gallery and the eleven-view marketing walkthrough remain as released.
