---
title: Guard navigation with acknowledged revisions and keep page-text recovery mounted
type: implementation
area: [dashboard, editor]
date: 2026-11-01
---

The full-scope UX round (issue #148, U2) moves paste and file creation through the
existing draft APIs before an explicit publish review. The live deployment endpoints
retain their contract. Historical source inspection reads the existing protected
version ZIP export; it does not restore a version or change either pointer.

The server refuses open audience rungs before publication (`SHARE_REQUIRES_PUBLISH`).
Final creation review therefore names the **planned** audience, publishes with
Restricted access, then applies sharing through the existing settings API. A sharing
failure is a partial success: retain the published canvas, say sharing needs
verification, and offer Check sharing. Do not claim the draft stayed unpublished.
Dashboard mocks must reproduce this precondition; an unconditional successful PATCH
hid the incorrect ordering until independent review.

## Recovery is part of the save contract

An unmount cleanup cannot await a save or show a recoverable failure. Keep the editor
mounted with the shared navigation blocker, await the save, then allow the route
change only when the current buffer is acknowledged. A failure offers retry, export,
or deliberate discard. Native beforeunload protects reload/close; it cannot guarantee
delivery of an asynchronous write.

The revision matters as much as the pending request. Typing while a PUT is in flight
requires another PUT with the acknowledged hash. Reverting to the original loaded
text during that request also needs another save: the first acknowledgment has just
changed the server's baseline. Recompute dirty state against the acknowledged body,
not the old loaded value. Background reads must not replace a dirty buffer or advance
its expected hash; doing so would turn a conflict into a silent overwrite.
Retain that hash when the remote manifest omits the file too: absence must conflict,
not grant permission to recreate another editor's deletion. A lost PUT response leaves
the server outcome uncertain, so reverting to old text remains dirty until an
acknowledgment or explicit conflict resolution. Set conflicts immediately; an optional
comparison GET must never hold navigation recovery hostage. Bound it and allow retry.
Key the editor workspace by canvas ID as well. Save guards do not cover every pending
create/upload/rename/delete; a reused route instance can otherwise retarget mutable
hook options or keep a selection and refs from the previous canvas.

The Page text shim posts each edit immediately and the dashboard owns the debounce.
Otherwise navigation can beat an iframe-only timer and the parent has no copy to
save. An oversized edit sends a bounded dirty/error signal, retains the iframe, and
blocks navigation. It cannot offer a source download that omits the latest edit.
Background read errors or a concurrently changed manifest must not remove that
iframe. Pin the active page path while dirty, and keep the last loaded workspace
mounted with a retry notice. The message source-window check and opaque-origin
sandbox remain in force.

## Keep preparation memory scoped and minimal

Creation preparation survives SPA navigation only in tab memory, scoped to the
authenticated account. Account changes invalidate it; passwords and deploy keys are
excluded through an explicit field projection. File objects may remain in the tab
but do not survive reload. State this limitation in the UI and retain the native
close/refresh protection. A partial upload retry reuses the created draft and resumes
after acknowledged files rather than deleting it or publishing a partial site.
Keep the pending draft ID, file cursor and uncertain-request marker in the same
account memory, without its one-time deploy key. After a lost upload response, compare
the server file hash with the intended bytes before advancing or retrying. A genuine
different hash stays a conflict. Otherwise an acknowledged-response-only cursor can
retry forever with `If-Draft-File-Hash: none`, or navigation can create duplicate canvases.

## Inspect source without running it

Historical inspection downloads protected exports with the existing role gates.
Check ZIP entry paths, declared expanded sizes, total size and count before inflation;
limit source rendering to small valid UTF-8 files. Render source with a named,
read-only editor, never in an HTML iframe. Version comparison is a byte comparison
of those exports and needs no mutation endpoint or separate authorization model.
Keep historical inspection bounds separate from creation compatibility: uploads accept
the server's 25 MiB per file, 100 MiB expanded and 2,000 usable files, with 110 MiB
for the ZIP container. Directory and hidden entries do not consume the usable-file
count. A test-only import of the canonical server limits prevents the browser mirror
from drifting without bundling server modules into the dashboard.

## Regression coverage

Creation tests exercise recovery, account switching, password clearing, partial
upload retries and explicit draft review. Editor tests cover newer/reverted revisions,
conflicts and permission loss, background refreshes, Page text continuation after
refusal, and an oversized iframe surviving route cancellation and manifest changes.
The shim test executes its input callback and verifies immediate and bounded messages.
Comment contrast tests use the real CSS tokens and all skin/theme surfaces, including
active and selected lines; checking only the plain editor background was insufficient.

For TanStack Router tests, start navigation outside an awaited React `act` callback
and wait for the target UI. Awaiting a navigation promise inside `act` can prevent the
transition needed to resolve it, leave an open act scope, and cascade timeouts into
unrelated cases. Wait for actual unmount before testing a return navigation.
