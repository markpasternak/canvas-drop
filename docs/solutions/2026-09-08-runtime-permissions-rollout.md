---
title: Runtime permissions rollout verification
date: 2026-09-08
category: deployment-and-verification
---

# Runtime permissions rollout verification

PR #117 merged as `048f1ed` on 8 September 2026 after every check passed. The user
explicitly authorized deployment, canvas migration and the admin merge override.

## Migration and recovery

The fresh production inventory found eight active canvases with backend features.
Current versions had advanced since the initial audit, so adaptations used fresh
source and refused to publish over an unexpected version change.

The cutover preserved existing sharing and roles. It moved 15 comments into an
authored collection and bound 12 images to their parent records. Original authors
were verified against creation audit events and upload attribution. IDs, values,
timestamps and author identities were preserved; stored value hashes matched.
Round settings and private drafts stayed separate. No compatibility mode was added.

A rehearsal ran against copied data and storage. The final stopped-service backup
passed database integrity and foreign-key checks and verified 3,927 stored blobs.
The new release and adapted canvases were activated together. Historical versions
were retained; this migration did not run version cleanup. Backup and rollback
material remain in the operator's private runbook, outside the public repository.

## Verification

- Authenticated pages and role identity for the eight backend canvases; the
  password-protected presentation retained its viewer gate and allowed editors.
- Live comment creation, own status changes, editor changes, cross-author update
  and delete rejection, bound-file read/write rules and parent deletion cleanup.
  Temporary test records were removed and the original 15 comments remained.
- Participant messages and presence on both roadmap channels, the review channel
  and showcase chat. The presentation's viewer/presenter controls and reaction
  permissions were checked locally; its production password gate was preserved.
- Viewer GET access through the existing market-data Connection; POST denied.
- Authenticated manifest readback matched every deployed file hash for the three
  adapted apps. Public health, service status and Google sign-in redirects passed.
- Viewer AI permission projection was checked; model output quality is outside
  this permission migration.

## Returning visitors and source ownership

The stable SDK URL may be cached for one hour. A fresh browser passing is not
proof that a returning visitor gets the new collection/file APIs. Affected canvas
script URLs now include a release query; normal reloads fetch a fresh SDK. Old
open review pages detect the new review revision and stop obsolete writes.

Canvas adaptations and migration scripts belong with the deployment's private
source/runbook. A published version is immutable: publish a new version for an app
fix, preserve held drafts, and compare authenticated readback hashes. Restoring an
old HTML version does not undo a backend data migration or restore old permissions.
