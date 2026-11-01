# Access/settings draft lifetimes and disclosed admin controls

The full-scope UX round keeps authority in the existing server services. UI summaries
and bulk-action counts guide selection; the operation preview and confirmation still
decide eligibility. Pending-grant cancellation must name a particular invitation ID,
not pick the first grant belonging to an email. Admin grant metadata uses left joins
so a missing target remains cancellable without dropping its invitation.

A draft's lifetime must outlive the controls displaying it. Configuration filtering
unmounts rows, so values, per-key write/reconcile locks, and errors live in the
route's keyed, in-memory map. A successful write with a failed effective-value GET
is acknowledged but awaiting refresh; it is not an unsaved edit and must not claim
that the inherited value is known. Refresh cleanup checks draft revisions so a
retry cannot clear newer input. Failed query refreshes retain mounted editors when
cached data exists. Templates retain acknowledged content until a successful read
started after acknowledgement reconciles it; retry never repeats the mutation. No
passwords, keys, protected headers or email drafts are written to browser storage.

Backend status can change in another session while policy edits are pending. Keep the
same policy editor mounted across that change, preserve the proposal's original
revision, and keep navigation protection active. Read-only/disabled fields must not
also disable the local Discard action. A return to Backend on can save the original
proposal through the existing revision check.

Canvas identity bounds the complete editing session, including TanStack mutation
hooks. Key the Share and Backend editor subtree by canvas ID: resetting local state
in an effect is too late because a pending mutation observer can adopt callbacks
from the next render and write its old result into the next canvas's query key.
Read generations alone also do not protect an access list from an old mutation
starting a new reload; scope the list by canvas and ignore completions after unmount.
For browser-Back regressions, use browser history in jsdom: the installed TanStack
memory history checks blockers for PUSH/REPLACE but skips them for BACK, so a memory
history test cannot prove the discard dialog's popstate behavior.

Drawers and dialogs share an overlay stack and one body-scroll lock. Only the top
layer consumes Escape or traps focus; a pending non-dismissable dialog still owns
that key. Restoring a lower layer must not unlock scroll or steal focus from a higher
one.

Long inspector panels keep their title and close action outside the scrolling body.
Focus traps must count native disclosure summaries and skip controls inside closed
disclosures; otherwise reverse Tab can land on an invisible control.

Password gates distinguish incorrect passwords, rate limits and temporary verifier
capacity failures while retaining status, Retry-After, and authentication ordering.
System recovery links are derived only after successful access, from a role already
known to the request. Generic missing/forbidden responses remain indistinguishable.
