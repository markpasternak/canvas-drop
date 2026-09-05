---
title: Refine the Editorial palette and close the improvement round
type: fix
status: active
date: 2026-09-05
---

# Refine the Editorial palette and close the improvement round

The owner approved the final palette refinement and cleanup. Keep Editorial as the instance default and System as the light/dark preference. Improve the shared neutrals and Editorial accent without changing page layouts, functionality, skin selection, or the gallery and eleven-view walkthrough.

- [ ] R1: Clean up light-mode paper tones, improve the separation of canvas/surface/controls, and retain a restrained deep teal accent. Make dark mode a related graphite palette with softer teal. Preserve readable text, semantic states, and focus indicators across all four skins.
- [ ] R2: Keep shared tokens, dashboard CSS, public pages and generated brand artwork consistent. Review homepage, library, detail and docs in light/dark, plus narrow screens and alternative skins. Run palette parity/contrast checks, lint, typecheck, full dual-dialect/dashboard tests and build.
- [ ] R3: Recapture all affected marketing and documentation images using isolated example data, regenerate the eleven-frame README animation and skin comparison, review every image, and verify deployed asset hashes. Review the change, merge through green CI, deploy, and verify production.
- [ ] R4: Inspect all local branches and worktrees after deployment. Remove merged round branches/worktrees, retain recoverable backups of local-only material before removal, preserve unfinished changes, and stop only task-owned local servers and browser sessions. Leave the shared checkout clean on current main. Tracking issue records the actual release and cleanup receipt.

The scope is shared neutral surfaces and the Editorial accent. Studio remains terracotta, Workshop green, and Canvas violet; no new skins, preference storage, or backend capabilities are introduced. Existing legal wording is unchanged. Color judgments are verified on rendered views and backed by contrast measurements rather than arbitrary new token snapshots.
