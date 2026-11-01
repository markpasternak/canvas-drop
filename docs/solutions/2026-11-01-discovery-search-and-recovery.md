# Discovery search and retained work after failed reads

Date: 2026-11-01
Plan: `docs/plans/2026-11-01-001-feat-full-scope-ux-plan.md`, U3

## Search must rank or filter before it limits

The command palette used the first library page as its search corpus. A local
filter could never find a canvas on later pages. It now requests the existing
server-filtered list, preserving description/tag matches, and offers further
matching pages with an explicit Load more control. Command matching stays local;
canvas matching does not apply a second title-only filter. The palette has a
visible shell trigger, useful result counts, loading, failure and Retry states.

Docs had the same ordering problem in miniature: limiting candidates before
ranking excluded later exact-title matches. Score the entire index by exact title,
partial title, heading, then body before selecting the first twelve. Include a
heading or body context and a total count. Keep one in-flight index request, clear
a failed request so Retry works, and suppress late responses after dismissal.
Keyboard focus uses native links; Safari's null `relatedTarget` must not cancel a
pointer click while the results still own focus.

## A failed refresh must not unmount recoverable input

An initial forbidden/missing canvas remains opaque. A failed initial transport
read gets Retry. Once the canvas has loaded, a later failed refresh keeps its
Outlet mounted with a clear stale-view notice; otherwise editor buffers and
metadata drafts disappear before their own recovery controls can run. All new
operations still pass through existing server authorization checks.

Overview metadata saves explicitly as one changed-fields patch. Failure retains
the attempted title, description and tags, with Retry and Revert. Navigation
uses the shared unsaved-changes blocker; Save and leave only proceeds after a
successful save. Missing version data stays Loading or Unavailable rather than
claiming no files, versions or storage.

## Layout should budget space for the task

Preview cards now keep identity in an opaque themed caption rather than competing
with the image. Publication and scope remain on the owner card; detailed metadata
stays in the list and detail view. Secondary filters are grouped or disclosed,
without changing their URL contract. The selected canvas rail opens inline only
at 1536px; narrower layouts use the existing drawer so cards remain usable. The
rail has a fixed Close control and a separately scrolling detail region.

Editor, Versions and Usage use compact shared context and their own primary task
actions. The same header keeps the title, publication state, URL and audience.
Public docs add a collapsed outline for long pages and exact-text command copy.
The landing walkthrough's named topic controls scroll horizontally within their
own strip; `scrollIntoView` would also scroll the whole landing page on initial load.

## Verification boundary

Regression tests cover later-page command matches and subsequent matching pages,
query-independent navigation, filter state, failed metadata saves and navigation,
retained input after a background 404, version-read failures, docs ranking,
keyboard focus, retry and command-copy failure. Existing library drawer, bulk and
list/grid tests remain in the full gate. Generated docs and carousel JavaScript
are rebuilt from source.

CUA checks in the isolated development runtime covered 1280px library cards and
drawer, 1536px inline rail/close, 320px disclosed library filters, compact Versions
context, and 1280px docs search/focus. The root integration round owns the complete
width/theme matrix and replacement walkthrough images. These checks do not claim
physical-device or screen-reader validation.
