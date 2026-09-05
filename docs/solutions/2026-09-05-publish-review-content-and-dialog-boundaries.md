---
title: Review content changes without treating every save as a new decision
type: improvement
area: editor
date: 2026-09-05
---

Publish review reads the saved draft and canvas audience through a short-lived query separate from the editor's file buffer. Flush local edits first; a failed save or failed confirmation refresh must not publish from cached details. Compare path/hash/size/mime and the live baseline/access fields before submitting. Writer names and timestamps change on byte-identical saves, so they must not force another content review.

The review does not introduce a server lock or change publish snapshot semantics. A real content or audience change requires another confirmation. The existing service remains authoritative for publishing, restoring a draft and making an earlier version current; HTTP and MCP share draft.describe for the additive changes and home-page projection. Use Object.hasOwn when classifying manifest paths: names such as constructor and toString can otherwise inherit Object.prototype values and mislabel additions/removals.

Restore to draft always confirms replacement of unpublished files, even when the draft query is unavailable or appears clean. Making a version current changes visitors' content immediately and preserves draft files. Pending recovery dialogs must prevent Escape/backdrop dismissal as well as disable their buttons.

Long review content exposed two shared-dialog defects: reverse Tab escaped when the panel had initial focus, and the panel exceeded a landscape phone while body scrolling was locked. Bound the panel to the dynamic viewport with internal scrolling, handle panel/empty-control focus, and choose the autofocus element before calling focus (focus returns void). Keep callback refs out of the effect dependencies to preserve the existing CodeMirror freeze fix.

Verification includes metadata-only saves, actual content and audience changes, failed refresh/save/publish, duplicate activation, empty drafts, recovery confirmation, shared HTTP/MCP projections and both database dialects. Browser verification exercised a local publish, restore with live version unchanged, then publication of the recovered draft; landscape scrolling and reverse Tab remained inside the dialog. Cross-model review used Claude Opus 5; local personas and validation were sequential inline passes under the repository tool mapping.
