---
title: Library to publish UX and release refresh
type: feat
status: completed
date: 2026-09-05
---

# Library to publish UX and release refresh

Approved by Mark: finish the first three units as three independently merged PRs, then complete the additional editing, accessibility, visual and release work. Owner approval includes merging green, reviewed PRs and deploying the final result.

## Product decisions

- **session-settled: user-directed** Preserve the existing Gallery and eleven-view marketing walkthrough. Public marketing visitors must not be sent into the authenticated Gallery.
- **session-settled: user-directed** Explain the distribution problem: artifacts created on a laptop or in a cloud/AI workspace need a maintainable home where the right people can use them.
- **session-settled: user-approved** Reuse the current permission model, service layer and MCP capabilities. Use Restricted in user-facing text.
- **session-settled: user-approved** Capture all marketing/documentation images after the UI changes; refresh the README animation and deploy only after the release assets and checks are complete.
- Retain the active design skin, list/grid choice, existing navigation semantics, URL filters and access boundaries.

## Implementation units

- [x] **U1 — Library recognition and filtering.** Make names and covers lead in Canvases and Shared; remove redundant row statistics; group advanced filters behind an accessible disclosure while keeping active filters discoverable. Preserve every filter, archived mode, bulk selection and URL history. Verify filter disclosure, URL-linked active filters, and selection reset when ownership changes; inspect list/grid at desktop/mobile.
- [x] **U2 — Resume work from details.** Put Open, Edit draft and Share together, with publication-aware actions and compact version/activity details. Keep duplicate and full management reachable. Verify draft, published, unpublished, archived and disabled states plus drawer keyboard behavior.
- [x] **U3 — Sharing confidence.** Place an accurate audience/protection summary beside Copy link and a direct route into people/teams. Reuse existing sharing controls and freshness/error safeguards. Verify Restricted, org and public access, pending grants, protection and unavailable canvas states.
- [x] **U4 — Publish review and version recovery.** Help editors inspect draft changes before publishing and understand recovery consequences before restoring a version. Use existing version/draft/publish/rollback APIs and MCP parity; no new publishing semantics. Verify changed/removed files, empty drafts, unsaved edits, API failures and recovery confirmation.
- [x] **U5 — Keyboard, mobile and CSS polish.** Inspect the complete core flow, fix concrete focus/overflow/touch-target/contrast issues and align spacing with existing tokens. Verify both themes and representative skins, reduced motion, narrow viewports and keyboard navigation. Avoid unrelated layout rewrites.
- [x] **U6 — Release assets and documentation.** Capture fresh seeded marketing and docs images of the finished UI, rebuild the README animated tour, improve the README's first read and verify commands/claims against source. Keep all eleven walkthrough views. Build generated docs, inspect the GitHub README and assets, review/test and merge.
- [x] **Release — Deploy and verify.** Inspect the existing production runbook, record current release and backup/rollback path, deploy merged main, then verify health, signed-out marketing/docs and authenticated core views. Record actual release SHA and observed state.

## Evidence and completion

Each implementation PR receives relevant regression tests, browser inspection, lint, typecheck, full dual-dialect/dashboard tests, code review and green GitHub CI before its independent merge. Pure visual changes use browser evidence instead of implementation-mirroring tests. Track actual results in the linked issue and completion notes here. No production content is used in public screenshots.

U1 verification: desktop and 390px mobile list/grid inspection; filter disclosure and reset, active count, owner/editor selection reset, keyboard navigation, and Shared cover cache-key regression coverage. Removed duplicate statistics and slug metadata while preserving Gallery. Review findings and stale assertions corrected before the PR gates.

U2 verification: publication-aware Open/Edit draft/Share and inactive-state tests; desktop rail and mobile drawer inspection, native disclosure, Escape and restored trigger focus. The API field named lastDeploy is the current version projection, so the panel labels it Live version (or Saved version while inactive). Archived cloning remains unavailable in the existing shared eligibility resolver.

U3 verification: shared owner/global public-link policy exposed through HTTP and MCP; Restricted aliases, organization scope, paused public sharing, password, timed expiry and unavailable lifecycle covered. Desktop and mobile link/People anchor inspection passed. The stale Copy assertion was corrected; cross-model review exhausted its turn limit, so the adversarial fallback and validation ran sequentially in the main thread.

U4 verification: draft change and home-page projections shared by HTTP/MCP; saved-content and audience preflight, failure recovery, duplicate submission, empty draft and mandatory restore confirmation covered. Review corrections include metadata-only save comparisons, prototype-named paths, unknown organization metadata, dialog focus/scrolling and pending dismissal. A browser publish/restore/publish cycle verified that recovery leaves the live version unchanged until publication. The independent Claude review completed; local persona and validation passes ran sequentially under the repository mapping.

U5 verification: canonical mobile font floor now wins over utilities, dialog opening mounts before focus, Share headings nest beneath the canvas title, fields expose help text and stable IDs, clipboard feedback ignores stale attempts, and the narrow header/editor toolbar fit. Browser checks and 2969 server / 731 dashboard tests passed with lint, typecheck and build. Independent Claude review and sequential local validation completed; actionable findings were corrected.

U6 verification: all eleven tour images, three empty docs views, the two-skin comparison and eleven-frame animated WebP were recaptured. The README now explains distribution, controlled access and ongoing revision without blanket security or URL claims. Docs embed the new images. Screenshot readiness and animation completeness checks prevent stale/empty captures; card clipping and the responsive calculator example were corrected during visual inspection. U6 merged in PR #108 after independent Claude review, corrected findings, and a green CI matrix.


Release receipt (2026-09-05): PRs #103, #104 and #105 were merged independently, followed by #106, #107 and #108. Release `1cdbb3b0e471221b5a81c6a73d054a86255a9380` was deployed after a pinned SQLite backup passed its integrity check. Application and proxy services are active, health and database checks pass, and no service warnings were logged after restart. All sixteen served image hashes match the release files; the eleven-view marketing carousel, documentation references and Google sign-in redirect passed verification. The merged GitHub README and animation were inspected in Safari.

Authenticated MCP checks verified the existing canvas/version state, the new public-link policy field and the draft's clean change projection without publishing or restoring production content. Full dashboard browser sign-in required Touch ID, so that production interaction check remains limited; the UI flows were exercised locally before release. A live Safari docs check found unconstrained screenshot widths; the follow-up CSS bounds article images to their column while preserving aspect ratio. Its local Safari inspection shows the complete image fitting the article. Track the follow-up deployment receipt on issue #102.
