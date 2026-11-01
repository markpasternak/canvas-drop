---
title: Full-scope UX verification and recovery patterns
date: 2026-11-01
type: verification
area: dashboard
---

# Full-scope UX verification and recovery patterns

Plan: [Full-scope UX round](../plans/2026-11-01-001-feat-full-scope-ux-plan.md).
Tracking issue: [#148](https://github.com/markpasternak/canvas-drop/issues/148).
Baseline: `a7bd462`. This ledger records implementation evidence; release gates are
listed separately. No production instance is involved.

## Initial assessment

Three parallel reviews covered member workflows/design, technical accessibility and
responsive behavior, and administration/public states. The combined qualitative
assessment was 26/40 across ten usability heuristics, with no P0 and nine P1 findings:

1. Create input disappeared after navigating away and back (live reproduction).
2. Editor exit relied on an unacknowledged best-effort write (source risk).
3. The editor document measured 1340px in a 1280px viewport (live measurement).
4. The code textbox had no accessible name (live DOM).
5. Comment contrast was below 4.5:1 in both themes (computed tokens).
6. Confirmation required a timed hold, with no native activation path (source risk).
7. Password rate limits/capacity failures claimed the password was incorrect (source).
8. A failed Connection grant read could claim there were no grants (source).
9. Pending-access cancellation selected the first unnamed grant (source).

Other proposals covered every major route: creation and onboarding, library and
discovery, canvas overview/editor/history/usage/sharing/Backend/settings, teams,
administration, landing/docs and account/system pages. Preserve the editorial design,
publication rechecks, role gates, opaque unavailable responses and MCP/service parity.
This is expert assessment, not user research or accessibility certification.

## Shared foundations and polish

- Errors remain until dismissed; identical errors are deduplicated. Success notices
  remain transient and cannot evict errors. Announcements use separate polite and
  assertive regions.
- `ReadError` separates failed reads from empty success. Static inline information
  stays quiet; changing status/error messages opt into announcement semantics.
- `useUnsavedChanges` awaits the caller's save acknowledgment or exposes a route
  resolver. Failure is never permission to leave. Native refresh/close gets an unload
  warning. The hook stores no content or credentials.
- In-page settings navigation updates the fragment without overwriting router history
  metadata and focuses the selected section.
- Hold confirmation has a normal button alternative. Blur, disable and unmount cancel
  the timer; a trailing activation cannot repeat the completed action.
- Shared phone/coarse-pointer controls have a 44px target. Switch tracks remain 40 ×
  24px inside that target. The browser check measured all six Backend switches at
  44 × 44px with a 320px document in a 320px viewport.
- Caret, underline offset and scrollbars use the existing palette. Forced-colors mode
  retains the system scrollbar. No new visual identity or decorative motion was added.

U1 gates passed: lint, typecheck, 191 root test files / 3,574 tests, plus 87 dashboard
files / 791 tests. The root harness exercises SQLite and PostgreSQL/PGlite in process;
two files and nine tests requiring optional/external infrastructure were skipped.
After the touch-target changes, lint/typecheck and the 11 shared confirmation/feedback
tests passed. Full integration and CI remain separate gates.

## Screen-by-screen delivery evidence

| Surface | Delivered change | Verification |
|---|---|---|
| Library and shell | Visible command search, grouped filters, quieter card captions, query-independent navigation, drawer below 1536px and closeable rail above | Live 83-item library: found a page-three canvas through command search from page one and navigated to its exact ID. No document overflow at 320/390/768/1024/1280/1440px |
| Shared | Explains direct/team/org discovery and distinguishes the Gallery; useful empty next step | Owner sorting and refreshed frame; no document overflow at 320/390/768/1024/1280/1440px |
| Gallery | Secondary filters collapse; filtered results do not repeat default shelves; listing help corrected | No document overflow at 320/390/768/1024/1280/1440px. Template action opened the correct dialog and Cancel restored its focus. High-density frame captured after local cover refresh |
| Create | ZIP/files/paste produce a private draft, then explicit review/publish and planned sharing; safe account-scoped recovery | Live two-file ZIP → unpublished draft → script-enabled preview → review → published public-link fixture; native `beforeunload` event observed on reload, preparation remained |
| Editor | Awaited save before leaving, retained failed/conflicted buffers, export/retry/discard, responsive panes and named source editor | Live blocked draft PUT → Versions navigation stayed in editor with retained text and recovery dialog → networking restored → Retry save and leave reached Versions; real two-editor 409 retained both local and remote text; Use their version recovered. No document overflow at 320/390/768/1024/1280/1440px; code and preview fit together at 1280px with the sidebar collapsed |
| Versions | Protected, read-only historical file inspection and comparison before restore | Live v1 inspection versus current v2: 0 added, 1 changed, 0 removed and 1 unchanged; named read-only source panes; 1280px document at 1280px |
| Usage | Explicit period/scope and dated accessible values | Rendered period and dated alternative agree with the 31 actual UTC buckets; regression tests cover the accessible values |
| Overview | Health and next action first, batched details save with retry/revert, truthful failed facts | Multi-tag paste component and saved Overview PATCH regressions passed (19 tests) |
| Teams, Share and Backend | Truthful failed reads; named roles and effective access; preserved pending edits; static Backend-off disclosure | Track tests and viewport checks; People role controls aligned at 112px on desktop, with 44px select heights and no document overflow at 320/390px |
| Settings and administration | Routine publishing/lifecycle hierarchy; eligible bulk actions; named pending-grant selection; persistent configuration drafts and local email preview | Admin filter → Project notes inspector; selected Jordan's exact Pricing Editor pending grant and cancelled its confirmation without mutating access. Command search was blocked beneath the confirmation. Configuration draft survived filtering its row away and back; dark configuration fit at 320px |
| Landing and docs | Concrete canvas/AI-to-team explanation; manual tour with named topics; installation CTA; ranked complete search with keyboard/retry; page contents and code copying | Live docs index failure → Retry → 7 ranked results; ArrowDown/Enter opened Configuration; On this page moved focus/hash to Design skins; 390px docs had no document overflow. All 14 high-density captures completed, including affected recaptures after dropdown changes |
| Account and system states | Inspectable identities, recovery before diagnostics, distinct password failure/rate-limit/capacity states, opaque unavailable responses | Dual-dialect route tests and track render checks. Viewer Liam opened published Pricing but received opaque Not found on management; editor Priya opened its editor without admin navigation; owner Dev verified |

The browser checks above use an isolated SQLite/storage fixture with example.com
identities. They do not involve production. Temporary browser request blocking was
removed after the failed-save check. The beforeunload event was captured through the
browser developer protocol; the automation browser dismissed it automatically, so
this is evidence of the registered warning rather than a physical-device dialog test.

All four skin previews fit at 1280px; the fixture was returned to Editorial afterward.
These checks preceded the app-wide dropdown consistency work; its later keyboard,
phone-layout and visual checks are recorded below.

## Review findings and dispositions

Three independent reviews inspected creation/recovery, access/concurrency and
discovery/shared interactions. The following findings were accepted and fixed:

| ID | Priority | Finding | Required verification |
|---|---|---|---|
| R1 | P1 | Create opened sharing before the first publish, rejected by the existing server contract | Review planned audience, publish first, recover truthfully from uncertain sharing; exercise real settings contract |
| R2 | P1 | A background file deletion dropped the dirty buffer's expected hash and could recreate the file | Retain the original hash; remote deletion produces a conflict |
| R3 | P1 | Reverting text during a save with an uncertain outcome could be mistaken for clean | Preserve uncertainty; committed PUT plus lost response cannot silently permit exit |
| R4 | P2 | Lost upload acknowledgment made retry repeatedly conflict on an already written file | Reconcile intended bytes; continue a two-file upload without duplicating the canvas |
| R5 | P2 | Partial-upload identity/progress disappeared after keeping preparation and leaving | Account-scoped recovery resumes the same draft, including a chosen slug, without storing API keys |
| R6 | P2 | A failed background identity refresh unmounted creation despite cached verified identity | Preserve the form and recovery path while showing a retryable refresh error |
| R7 | P2 | The Add index.html repair action bypassed save-before-switch | Rejected save retains the current CSS/JS buffer and creates no replacement file |
| R8 | P2 | Conflict recovery waited indefinitely for an optional comparison read | Present recovery immediately; a hung comparison request cannot trap navigation |
| R9 | P2 | Configuration row remounts lost pending-request ownership, allowing an old Save/Reset completion to clear newer text | Keep per-key pending/revision state across filters; delayed completion cannot clear a new draft |
| R10 | P2 | Connection profile save/create responses could erase text entered while pending, including Cancel/reopen | Lock the edit session or acknowledge only the submitted revision; cover delayed save/create and reopened editors |
| R11 | P1 | Cached canvas navigation could carry a pending Backend policy into another canvas | Scope editor, dirty state and mutation ownership to canvas identity; verify Discard-and-leave and late completions |
| R12 | P2 | A delayed Add-person completion could reload the previous canvas roster under the next canvas | Scope child mutation continuations and parent callbacks to their original canvas |
| R13 | P1 | Changing pending mutation observer options could write one canvas's response or rollback to another cache key | Remount the owning editor/mutation session by canvas ID; assert cache identities on delayed success and failure |
| R14 | P2 | Pasting several comma-separated tags used stale state for each segment and kept only the last | Accumulate/deduplicate once; verify combined limit and saved Overview payload |
| R15 | P2 | An underlying detail drawer handled Escape while a duplicate dialog was above it, even during a protected request | Share top-overlay ownership and scroll locks; preserve pending dialog, selection and restored focus |
| R16 | P2 | The editor's fullscreen layer at z-index 50 painted over navigation recovery | Close fullscreen when navigation is blocked; 83 tests across four files passed, including Keep and Retry recovery. Independent source recheck cleared the fix |
| R17 | P2 | Tailwind 4's `focus:outline-none` overrode the select's `focus-visible` outline | Removed `focus:outline-none`; keyboard checks confirmed native and filter selects have a solid 2px accent outline with a 2px offset |

The independent U2 recheck verified R1–R8 resolved in source and inspected the added
regressions, including the chosen-slug follow-up. That source recheck ran no tests or
browser actions; execution evidence is recorded separately. The U4 recheck cleared
R9–R13; the discovery recheck cleared R14/R15. The final template reconciliation source recheck also cleared the fix.

Related U4 review items: handle failed effective-configuration refresh explicitly,
mutually disable template Save/Reset, and match bulk eligibility labels to the existing
purge-started/purged restrictions already enforced by server previews.

Implementation-time review also found oversized Page text silently dropping messages,
dependent version facts claiming empty success after read failure, policy drafts
disappearing when another editor disabled Backend, and Share drafts disappearing after
background unpublication. Focused regressions were added by the owning tracks.

All three independent source passes and the R1–R15 patch rechecks are complete.
Additional access-form tests retain newly typed input when an earlier add finishes;
template tests distinguish an acknowledged write from a failed refresh. The final
combined suite and release gates remain separate.

The final U2 integration review cleared the three automatically merged files, including
their API fields and tests. It then identified R16. The fix, focused tests and
independent source recheck are complete. The later dropdown source review identified
R17; its fix was verified with actual keyboard focus on both select treatments.

A final acceptance review found Create ZIP inspection accidentally inherited the tighter
historical-viewer limits. Upload parsing now matches the existing server contract
(25 MiB per file, 100 MiB expanded, 2,000 usable files), while history keeps its bounded
20 MiB / 1,000-file inspection. Directory entries do not consume the upload count.
Nine focused regressions passed, including a 21 MiB asset through Create. The
independent source recheck found no other U2–U4 acceptance or MCP parity gaps.

## Track and integration test evidence

The final combined branch passed all local gates. Earlier track results are retained
below to distinguish intermediate checks from the final integrated run:

- U2 was integrated as `a4c1ae1`. Its root suite passed 3,588 tests with nine skipped.
  The dashboard run passed 816 of 817; the remaining test used the old Paste HTML
  selector. After correcting that selector, all 19 app tests passed.
- U4 was integrated as `50c288b`. Its full rerun passed 3,583 root and 829 dashboard
  tests after two stale admin selectors were corrected.
- Root polish ran 97 focused tests across seven files and found one stale CSS
  assertion. After updating it, all 11 card tests passed. The initial landing run
  passed 24 tests; the final copy/picker run passed 25 rendering tests and eight
  controller tests. Embedded onboarding uses an h2 under the page heading.
- Automatic preview framing was integrated as `3837022`. All 41 focused tests across
  five files passed, including the review fix that bounds fallback resize to one
  second. Twelve local demonstration covers were regenerated.
- The dropdown-focused run passed 122 tests; one existing test hit its five-second
  timeout. The final combined run uses the already established invocation-only
  90-second deadlines passed all 880 dashboard tests, including that scenario.
- After the dropdown changes, lint (837 files), typecheck, build, generated-docs
  parity and bundled-Mermaid parity passed.
- The first combined root run passed 3,619 tests, skipped nine and failed one stale
  “Share it out” assertion. That assertion now targets the stable Introducing region.
  The fresh full run then passed all 3,620 root tests and 880 dashboard tests.
- Final full-suite result: 193 root files passed, two skipped; 3,620 tests passed,
  nine skipped. All 91 dashboard files and 880 tests passed. The eight carousel
  controller tests are included in the root Vitest suite. Lint, typecheck, build,
  generated docs and bundled Mermaid also passed. Local timeout/worker overrides
  were invocation-only; the unchanged CI matrix remains the authoritative gate.

## Patterns to preserve

- An edit has both an identity and a revision. Acknowledging a request must not clear
  later input, including input that returns to the original text. A missing response
  leaves uncertainty even when the displayed text matches the old baseline.
- Missing from a fresh manifest does not mean a dirty file never existed. Keep its
  original hash so a concurrent deletion produces a conflict instead of resurrection.
- Put recovery state above anything that filtering, loading errors or lifecycle changes
  can unmount. Retaining text alone is insufficient for partial creation: preserve the
  existing canvas identity and upload progress, excluding passwords and API keys.
- Scope editing sessions and mutation hooks to the target canvas. Resetting a hook in
  an effect is too late if its library has already changed a pending mutation's options.
  Tests must assert cache identities and permissions, not only visible draft text.
- A save remains pending through required reconciliation. Per-row hook state cannot
  represent that request if the row can be filtered out and remounted.
- Optional comparison reads must not block essential Keep/Download/Discard recovery.
- Overlays need one stack for Escape, focus and scroll locking. Independent document
  listeners cannot infer which overlay is on top from registration order.
- Recovery must also remain visible above fullscreen workspaces. When navigation is
  blocked, leave fullscreen before presenting the recovery choice.
- Check computed keyboard focus after changing Tailwind focus utilities. A general
  `focus:outline-none` can override the intended `focus-visible` outline in Tailwind 4.
- Test the existing service contract when composing a new workflow. A permissive UI
  mock hid the rule that open sharing requires an already published canvas. Keep that
  invariant and make partial success explicit instead of bypassing it.

The hybrid run keeps independent implementation and review parallel, but serializes
full local suites. Heavy host load caused timeouts in unchanged PostgreSQL alias and
MCP identity tests. Subsequent local full runs use one worker and invocation-only
90-second test/hook deadlines; committed settings and assertions remain unchanged.
The normal CI matrix remains the authoritative merge gate.

## Additional visual direction during the run

Mark requested clearer gallery cards and sharper landing/README imagery. Card titles,
metadata and always-visible template/overflow actions now sit below the preview; only
the library selection control remains above it. Captions use a compact title/status
row and retain descriptions, tag filtering and owner attribution.

A live comparison confirmed the remaining thumbnail whitespace was inside the captured
canvas, not the card. The baseline 1440 × 960 viewport leaves small tools at the top.
The framing subunit uses a 900 × 600 desktop viewport with the existing 2× density,
falling back to 1440 × 960 for horizontal overflow or an unavailable bounded probe.
It does not infer content bounds, crop DOM regions, change custom covers, or relax
capture isolation. Short pages and horizontally overflowing desktop layouts require
separate visual verification. The regenerated short/responsive demonstrations,
including Q3 and Calculator, showed improved framing.

For the overflow fallback check, a new local “Wide layout” fixture
(`01a195d9-d7f3-77a1-836b-eee3a306ec17`) was created at a 390px viewport through Create
draft → Review → Publish Restricted. Its preview worker completed on its first attempt.
The actual 1200 × 800 card WebP showed all three Left/Middle/Right columns of the
1200-CSS-pixel layout,
confirming that the 1440px fallback was used. The retained visual evidence is
`thumbnail-wide-fallback.webp` in the run's local `canvas-drop-ux` evidence directory.

Landing/docs frames use a consistent 1280 × 800 CSS viewport captured at 2× density
(2560 × 1600 pixels), with WebP encoding and an animated WebP README loop. This is
a real browser capture, not enlargement of the previous screenshot.

All 14 tour/docs images are refreshed at 2560 × 1600. After Mark requested consistent
dropdowns throughout the app and a new People image, the 11 affected images were
retaken. People, Sharing and Preview use 24px section framing so the preceding heading
is not clipped at the top. The rebuilt README animation has 11 frames at 2560 × 1600,
a 3,000ms delay per frame and loop value 0; its size is 1,195,998 bytes.

All 14 raw native-select call sites now use `NativeSelect`, and `FilterSelect` shares
its styling. A source search found raw `<select>` markup only inside `NativeSelect`.
Desktop People role controls are all 112px wide and right-aligned. At 320px and 390px,
the page has no document overflow and every select is 44px high. After R17 was fixed,
keyboard focus on native and filter selects produced a solid 2px accent outline with
a 2px offset. A fresh independent visual reviewer inspected five captures and returned
“ship” with no issues.

The landing refinement introduces a canvas as a live page or app made with AI and
shared with a team. The walkthrough is user-controlled, with captions beside desktop
images and below phone images. Its compact topic picker retains all 11 topics, marks
the selected topic with a check, and supports keyboard navigation. Without JavaScript,
the screenshots and captions remain available through native scrolling; reduced motion
removes animated transitions.

The final landing runtime check found document width equal to viewport width at
320/390/768/1024/1280/1440px. At 320px the open topic menu occupied x=44–300px
(256px wide), within the viewport. Typing “g” and pressing Enter selected Gallery
(7/11). End followed by Escape left the original workspace slide selected and focus
on the trigger. With reduced motion emulated through the browser developer protocol,
Next reached slide 2/11 correctly. Disabling JavaScript execution and reloading left
11 native-scroll slides, hidden enhanced controls and horizontal overflow set to
auto. JavaScript and media settings were restored after the checks. Final default-brand,
light and dark captures at 390px also passed visual review. These checks do not claim
physical screen-reader testing.

The Impeccable source detector ran once over 61 changed files and returned no findings.
This preceded the final footer wording and the dropdown scope; no second detector run
is claimed. The dropdown changes received the separate source and visual reviews
recorded above.

A fresh independent visual/language review inspected nine captures and returned
“ship” with no fixes. The harness could not load the named Impeccable finisher directly,
so the generic reviewer followed the disclosed degraded contract. This was a visual
and language review, not a substitute for code, interaction or release checks.

The documenter confirmed the existing Editorial Creator OS identity and left
`DESIGN.md` unchanged. It did not create the absent `.impeccable/design.json` sidecar
or repair older drift: PRODUCT's font/motion wording, DESIGN's Shared/navigation
wording, and an existing 200ms sheet animation against the documented 180ms limit.
These were reported rather than turned into new design rules.

## Release gates and limits

Integrated journeys, visual checks, image refreshes and independent reviews are
complete, and the full local suite is green. All required CI and secret-scan jobs
passed for `ce7656e7ab475b208784783f99d9174fdcd81f85`. [PR #149](https://github.com/markpasternak/canvas-drop/pull/149)
was squash-merged as `4b8fc645bc942e6e6a4805c21fb27e4187eb10c5` on 1 November.
Issue #148 is closed with its checklist complete, the remote branch was deleted
by GitHub, and the shared main checkout was pulled clean. No production deployment occurred.

Physical-device touch, real screen-reader/voice operation, live OIDC identity-provider
sessions and production load are outside the available local evidence. Semantic
regressions, emulated viewports and source review do not substitute for those checks.
