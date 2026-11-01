# Full-scope UX reliability, workspace and publishing round

Date: 2026-11-01 · Issue: [#148](https://github.com/markpasternak/canvas-drop/issues/148)
Status: implementation and local verification complete; required PR CI and authorized merge are the remaining release gates.
Integration branch: `feat/ux-full-scope-2026-11`.

## Outcome

Deliver all three rounds from the 1 November screen-by-screen UX review: reliability
and accessibility, working-space improvements, publishing and discovery, then polish.
Keep the Editorial Creator OS identity, existing features, authorization invariants,
and the explicit draft/live distinction. No production deployment is included.

The initial review found lost Create input and configuration edits, unreliable editor
exit saving, a 1340px document in a 1280px editor viewport, incomplete command search,
misleading failed-read/password states, ambiguous pending-grant cancellation, and
accessibility gaps. Improvements below cover the entire reviewed surface, not only
those defects. Source-only risks must be verified in tests before calling them fixed.

## Architecture and constraints

- `BUILD_BRIEF.md` remains authoritative. Deploy remains live; draft-first creation
  composes existing authenticated create + draft upload/write services and does not
  reinterpret ZIP/deploy endpoints. Reuse existing MCP equivalents; add a tool only
  for a genuinely new server capability, through the same role-gated service.
- Version inspection is read-only and role-gated, does not replace the working draft,
  and does not create a public historical-content endpoint. Prefer existing version
  export/manifest primitives; bounded file comparison or sandboxed local preview may
  compose them. HTTP/MCP access must remain equivalent.
- Keep missing and forbidden objects opaque; distinguish transport/server failures
  without leaking object existence. Admin inspection is not content impersonation.
- Recovery does not silently persist secrets. Prefer account-scoped in-memory draft
  recovery plus explicit route/unload protection; any browser persistence needs an
  account-bound lifetime and clearing on sign-out. Failed/conflicted edits remain
  exportable. File handles cannot be silently restored after refresh: explain/reselect.
- No schema change is expected; if needed, additive migrations for both dialects are
  mandatory. All configuration remains typed and all env access stays in config.
- Preserve safe confirmations, publication tokens, stale-write checks, runtime policy
  revisions and audit events. Standard activation must have an accessible explicit
  confirmation path; holding must not be the sole input method.
- Refine the existing visual system. Do not rebrand, add external fonts/telemetry, or
  shrink type to solve density. At 320/390/768/1024/1280/1440px, content must reflow
  without document-level horizontal scrolling (intentional code/table scrollers stay).

## Hybrid execution and ownership

U1 is sequential on the integration worktree. After its gates pass, U2/U3/U4 run in
three separate worktrees/branches based on the same foundation. Each track implements
reliability first, then layout, then publishing/discovery refinements. One unit commit
per track after lint, typecheck and full dual-dialect tests pass. Root integrates
commits one at a time, reruns gates and owns shared-file resolution. No agent edits
another track's worktree. Read-only research/planning can run during U1.

Root owns shared feedback/confirmation/navigation primitives in U1. U2 owns CodeEditor,
editor/create/version/usage routes and their new recovery helpers. U3 owns app shell,
command palette, library cards/rail, library/shared/gallery routes, docs and landing.
U4 owns teams/share/backend/settings/admin routes, policy/access components, password,
account/system renderers. `lib/api.ts`, queries/mutations, routing and MCP/server
service changes are coordinated explicitly before edits; root resolves any overlap.

## Units and acceptance criteria

### U1 — Shared feedback and accessible interaction foundations (root)

- [x] Error notifications remain readable/dismissible; routine success remains transient.
- [x] Dynamic inline notices opt into alert/status semantics without making every static
      information panel announce on render. Skeleton loading can expose a concise status.
- [x] In-page navigation moves focus to the selected section while preserving useful
      fragment state. Native keyboard, pointer and assistive activation remain supported.
- [x] Hold confirmation has a standard explicit activation alternative, no accidental
      double execution, and no late timer action after blur/disable/unmount.
- [x] Shared read-error presentation supports Retry and does not claim empty success.
- [x] Tests cover ordinary click/keyboard confirmation, cancellation, persistent errors,
      navigation focus, and existing component contracts.

### U2 — Creation, editing, history and usage (track A)

- [x] Onboarding makes Connect your agent first-class, with Paste/Upload and optional API
      detail. Create API copy describes creating a canvas, not merely a credential.
- [x] Preserve creation input across navigation; protect refresh/close while unsubmitted.
      Keep title/content on failed creates; explicit discard clears recovery. Uploaded
      files and passwords have deliberate safe recovery semantics.
- [x] Add draft-first review for paste/uploads using existing draft APIs; publishing is
      still explicit, no broadened audience or deploy-contract changes. Show entry page,
      file count, destination and audience before publication; fix heading hierarchy.
- [x] Creation success prioritizes opening/managing the artifact; key handling optional.
- [x] Editor buffers survive failed/conflicted navigation; route exit waits or offers
      retry/export/discard. Page-text changes participate in the same recovery contract.
- [x] Container-responsive panes fit ordinary laptops; optional third pane, readable file
      names, grouped secondary actions and clear Page text mode. Compact working context
      must not hide publication state, stale warnings or primary publish action.
- [x] Code editor accessible name/read-only/help; comment contrast >=4.5:1 on light/dark
      backgrounds. Dynamic save/conflict state announced; error and version load Retry.
- [x] Read-only old-version inspection/comparison before restore, preserving draft/live
      pointers. Use existing protected export services or add shared-service MCP parity.
- [x] Usage explains scope/period/unique views, exposes dated values in an accessible
      alternative and links disabled Backend guidance to setup.
- [x] Tests: creation navigation/failed request/discard/draft-first; failed editor save,
      stale conflict/permission loss and exit; accessible editor; history inspection
      never mutates draft/live; authorized role matrix; usage data alternative.

Integrated as `a4c1ae1`; implementation criteria are complete. The track's root suite
passed 3,588 tests with nine skipped. Its dashboard run passed 816/817 before a stale
Paste HTML selector was corrected; the subsequent 19 app tests passed. The final merge
review cleared the three automatically merged files. A later fullscreen/recovery
finding (R16) is fixed with 83 tests across four files passing and its independent
source recheck cleared. The combined final suite remains a U6 gate.

### U3 — Library, discovery, landing and documentation (track B)

- [x] Shell active state ignores content query parameters; command search discoverable,
      server-filtered and complete beyond page one; Shared/Teams commands included.
- [x] Simplify card metadata, group library filters by purpose and normalize draft labels.
      Retain list/grid, bulk actions and URL state. Selected rail has a clear close action
      and preserves usable cards at laptop widths. Preserve consistent Open/Details cues.
- [x] Shared explains its scope and offers a next step when empty. Gallery collapses
      secondary filters, avoids repeated shelves in filtered results, fixes listing help.
- [x] Canvas overview prioritizes health and next action, removes duplicate facts and
      preserves attempted metadata on save failure with retry/revert/status. Compact
      shared canvas chrome cooperates with U2 without competing upload/publish actions.
- [x] Landing walkthrough has named topic controls; self-host CTA targets installation.
- [x] Docs rank exact/title then heading then body matches before limiting; keyboard
      result navigation, meaningful context, loading/failure/retry and result counts.
- [x] Long docs have On this page and command-copy controls; remove stale audit-viewer
      exclusions/tool counts. Rebuild generated docs and carousel assets when relevant.
- [x] Tests: later-page command match and failure/empty, query-independent nav, filter
      preservation, failed metadata save, docs relevance/keyboard/retry, generated parity.

### U4 — Access, Backend, admin and system states (track C)

- [x] Teams/rosters show read failures separately, Retry, expansion semantics/member
      context and quieter management actions; removal has clear impact feedback.
- [x] Sharing retains unified people/teams, durable pending state, effective-access
      summary and coherent save feedback. Failed expiry/password edits remain visibly
      unsaved; discovery/template metadata and descriptions clarify Shared vs Gallery.
- [x] Backend-off is a concise static state with optional saved-settings disclosure;
      enabled features group practical explanation, audience and effective resource
      rights. Preserve revision-aware Save/Discard; protect pending policy edits.
- [x] Settings emphasize routine publishing choices; lifecycle explains restoration path
      and distinction among unpublish/archive/delete. Keep protected key/URL operations.
- [x] Admin filters disclose advanced controls; publication and lifecycle are distinct.
      Bulk actions reflect eligible selection; preserve authoritative preview/guards.
- [x] Inspector/offboarding keep orientation and concise impact/unresolved summaries;
      group long lists and inactive policies. Empty routine reviews collapse.
- [x] Pending-access cancellation selects/names the exact grant. Owned count links to
      ownership; broader Review access is separate. Tests cover multiple pending grants.
- [x] Activity groups date range and simplifies advanced IDs, validates range and explains
      no-events vs no-matches. Connections distinguishes loading/failure/empty; resets
      cancelled drafts and clarifies profile/candidate controls.
- [x] Configuration drafts survive filters; dirty/reset/inheritance state accurate; common
      editable tasks distinguished from all settings. Secret drafts stay memory-only.
      Email template rendered preview is local/sandboxed; pending edits are protected.
- [x] Password wrong/rate-limited/busy messages distinct with Retry-After guidance, visible
      label/show-password and accessible errors. Preserve all auth/rate-limit gates.
- [x] Public/system errors prioritize safe recovery over diagnostics, preserving opaque
      unavailable responses. Account identities can be fully inspected; authorized empty
      assets receive appropriate recovery without exposing ownership/takedown details.
- [x] Tests: transient reads, multi-grant cancellation, configuration filter/reset/dirty,
      connection errors/cancel, password 401/429/503, opaque auth states, save failures.

Integrated as `50c288b`; implementation criteria are complete. After two stale admin
selectors were corrected, the track's full rerun passed 3,583 root and 829 dashboard
tests. R9–R13 and the template reconciliation fix passed independent source rechecks.
The final combined suite and release checks remain U6 gates.

### U5 — Integrated journeys, visual verification and polish (root + tracks)

- [x] Verify create → draft → preview → publish → share; edit → failed save/conflict →
      recover; find later-page canvas; admin filter → inspect → named access operation.
- [x] Verify seeded owner/editor/viewer and unavailable states, long names, empty/error
      views, light/dark, desktop/mobile widths, keyboard focus and reduced motion.
- [x] Improve automatic thumbnail framing for small tools: use a compact desktop
      viewport with a larger-viewport fallback for horizontal overflow, keeping
      capture isolation, deadlines, custom covers and output contracts unchanged.
      Verify representative short, responsive and fixed-width content.
- [x] Refresh all landing screenshots and the README animation from the finished UI,
      using a consistent 1280 × 800 CSS viewport at 2× density (2560 × 1600 pixels).
      Keep gallery screenshots clear of metadata overlays; place always-visible actions
      below previews with compact captions. These refinements were explicitly requested
      during the run.
- [x] Substantially improve the landing page's copy, first viewport and carousel:
      introduce the product directly, bring real screens forward, make topic selection
      and navigation obvious, and provide crisp full-size image links. Refine the topic
      picker and its open menu as one accessible component, including phone layout,
      keyboard behavior, reduced motion and the no-JavaScript fallback. This extends
      U5 at Mark's explicit request during implementation.
- [x] Make dropdowns consistent across the app: use one native-select treatment for
      the 14 raw select call sites, align filter triggers and pending-access rows,
      independently review the change, then recapture People and other affected
      screenshots and rebuild the README animation. Mark explicitly added this scope
      after the first landing/image review; implementation and review are complete.
- [x] Build and check docs/assets, MCP inventory and role matrix; all new owner-facing
      capabilities have service and MCP parity. No new owner-only bypass.
- [x] Run Impeccable detector once on completed UI changes, resolve real findings and
      record contextual exclusions. Preserve no-source-edit findings as verified retain
      decisions rather than inventing changes to sound comprehensive.
- [x] Record evidence/limits and concrete learnings in docs/solutions. Final release
      status follows the U6 gates.

Current evidence is recorded in
[`2026-11-01-ux-verification.md`](../solutions/2026-11-01-ux-verification.md).
Library, Shared, Gallery and Editor have no document overflow at the six planned
widths; the editor fits code and preview together at 1280px with the sidebar collapsed.
Owner/editor/viewer routes, named pending-grant confirmation without mutation, retained
configuration drafts, four skin previews and dark 320px configuration were checked.
Automatic framing (`3837022`) passed 41 focused tests; 12 local demo covers were
regenerated, and a fixed-width fixture's actual preview showed all three columns,
confirming the larger-viewport fallback.

All 14 tour/docs captures are 2560 × 1600, including 11 images retaken after dropdown
changes. People, Sharing and Preview use 24px section framing. The rebuilt README
animation contains 11 frames at 2560 × 1600, with 3,000ms per frame, loop value 0 and a
size of 1,195,998 bytes. The manual 11-topic landing tour passed 25 rendering and eight
Vitest controller tests. Runtime checks found no landing overflow at the six planned widths; the open
menu fit at 320px, typeahead selected Gallery, Escape preserved selection/focus, and
reduced-motion and JavaScript-disabled navigation worked. All 14 native-select call
sites now share `NativeSelect`, with matching filter styling. People role controls are
112px wide and right-aligned on desktop; at 320/390px there is no document overflow
and every select is 44px high. Source review caught a Tailwind 4 focus-outline conflict
(R17); the fix passed actual keyboard-focus checks on native and filter selects.
The dropdown-focused run passed 122 tests with one existing five-second timeout;
the final full run passed all 880 dashboard tests, including that scenario. A fresh independent visual
review inspected five captures and returned “ship” with no issues.

One Impeccable detector run over 61 files found no issues before the footer and
dropdown follow-up. The earlier independent visual/language finisher reviewed nine captures
under its disclosed generic/degraded contract and returned “ship”; the documenter
preserved the existing design authority and reported older drift without repairing it.
The combined full suite also passed; required PR CI remains the authoritative merge gate.

### U6 — Independent review and release (root)

- [x] Independent reviewer passes: correctness/recovery/concurrency, auth/service/MCP
      parity, UX/accessibility/responsiveness. Reviewers do not review only their own code.
- [x] Fix all real P0/P1 and high-value P2 findings, add regression tests and rerun
      affected checks. Record findings and dispositions in the verification ledger;
      the full gate remains the next item.
- [x] `pnpm lint`, `pnpm typecheck`, full `pnpm test` (SQLite + PGlite + dashboard), build,
      generated docs and Mermaid parity pass before push.
- [ ] Open one PR closing #148; wait for every required CI job (including real PostgreSQL
      and S3-compatible smoke tests), fix failures, squash merge and delete branch.
- [ ] Update tracking checklist after merge, pull clean main and report merge/test evidence.

Final local gates passed after the dropdown changes: lint (837 files), typecheck,
build, generated-docs parity, bundled-Mermaid parity, and the full suite. The final
run passed 3,620 root tests (193 files; nine skipped in two files) and 880 dashboard
tests (91 files). This includes the corrected stable landing-region assertion and
all dropdown regressions. Required PR CI and merge remain release gates.

## Retained behavior and deliberate boundaries

The review praised publication rechecks, restricted defaults, role-aware direct access,
configuration provenance, privacy-preserving unavailable screens, admin impact previews,
and configured OIDC/proxy login. These remain acceptance criteria, not forced rewrites.
No new login system, public version hosting, secret persistence, production rollout,
general rebrand, or changes to the deferred M10 load test/IAP pilot are included.

Actual assistive-technology and physical-device checks are reported honestly when not
available; semantic regression tests and emulated viewport checks do not replace them.
