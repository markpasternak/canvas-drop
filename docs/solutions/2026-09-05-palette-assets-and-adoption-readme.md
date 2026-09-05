---
title: Keep palette generators consistent and the README focused on adoption
category: workflow
date: 2026-09-05
---

# Palette assets and an adoption-focused README

Palette changes reach more than dashboard CSS. Update the shared token ramp, system-page shadows, browser metadata, manifest, adaptive SVGs, raster icons and social artwork. The dashboard-local `brand:icons` command previously maintained its own colors and could silently restore an older palette. It now calls the same `buildIcons` function as `brand:build`. Convert opaque OKLCH tokens to sRGB hex for raster artwork and browser metadata; keep live UI styles in OKLCH.

Check declarations in each SVG's light and dark blocks, rather than checking that both colors appear somewhere in the file. Keep browser metadata aligned too. Contrast checks cover foreground, muted and subtle text on shared surfaces, including hover, and accent text/buttons/focus across all four skins. A hue guard must parse the third component: a loose word-boundary search for `270` also matches decimal lightness `0.270`. Keep percentage and alpha forms covered.

The existing password-gate test pinned the old accent even though its comment promised the canonical token. Referencing `BRAND_TOKENS.light.accent` tests that the rendered gate uses the shared palette without rejecting a deliberate recolor.

For captures, pass custom database and storage paths explicitly to seed commands. `seed-collaborators` does not load the root `.env` like some sibling seeds; `node --env-file=.env --run seed:collaborators` did not reach the intended database in this environment. An exit code of zero was insufficient: the log reported missing demo slugs. Verify the target database and actual people-list rows before capturing. Use local example identities and clearly described synthetic usage, then inspect every final frame. Never use production data to fill a marketing screenshot.

The README is for someone deciding whether to adopt the product. Lead with the publishing/distribution problem, show the current product, explain fit and give one clear local-start path. Keep agents, optional backend capabilities and team operations informative but compact. Internal milestones and deferred work belong in `docs/project-status.md`; update internal references when moving that ledger. First-run button labels and documentation links must match the current UI.
