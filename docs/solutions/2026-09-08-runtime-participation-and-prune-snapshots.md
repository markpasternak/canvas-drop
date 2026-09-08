---
title: Runtime participation and immutable prune selections
date: 2026-09-08
category: security-and-data-integrity
---

# Runtime participation and immutable prune selections

The implementation under issue #116 separates canvas editing from participant
input. It shipped in PR #117; see
[rollout verification](2026-09-08-runtime-permissions-rollout.md) for the subsequent
production migration and checks.

## Bound the action to the resource that was reviewed

Version numbers are allocated from remaining history and can be reused after a
row is deleted. A confirmation carrying only `version: 3` could remove a replacement
created after the preview. Prune previews therefore return `expectedVersionIds`
as well as numbers. The repository DELETE combines canvas, number, expected UUID,
ready status and exclusion of the live pointer in one predicate. Missing, current
and replaced rows are skipped. One garbage-collection pass follows the batch.

Space estimates count unique selected hashes and exclude surviving versions,
draft references and active upload manifests. The estimate is never a recovered
byte count. A regression test prunes a real version while an active upload holds
one of its blobs, then verifies that held blob remains and the obsolete blob is gone.

## Separate identity, feature availability and operation permission

Runtime HTTP derives owner/editor/viewer from the existing live access context.
Management keeps its owner/editor grant separate. Shared KV and file mutations
need an editor role; private preferences remain caller-only. Submissions use a
reserved KV scope and the authenticated author as the key. Owners/editors can
review responses, but this does not expose another user's private preferences.
Client-supplied author IDs and timestamps are only response data, never attribution.

File listing now varies by viewer, so **metadata lists as well as content** need
`Cache-Control: private, no-store`. A URL is not an access grant. Both list and
content filter private submissions; deletion applies author/scope constraints in
the SQL predicate too. Existing file rows default to shared on both dialects.

Realtime revalidates the sender before each publish. The socket adapter serializes
frames through a bounded queue so async role checks cannot reorder messages.
Ordinary channels accept owner/editor publishers; `participants:` channels accept
attributed viewer input and are readable by any admitted subscriber. Private
responses belong in submissions, not participant broadcasts.

## Match nested Hono middleware to the parameterized path

A `*` middleware inside a mounted sub-app did not receive a later handler's
`collection` parameter. Submissions validation must match `/:collection` and
`/:collection/*` explicitly. The dual-dialect HTTP fixture caught the otherwise
valid caller-scoped writes returning 400. Keep coverage through the mounted
runtime API rather than testing an isolated parser alone.

## Verification

Server coverage includes direct, team and general-access roles, admin-as-viewer,
forged attribution, another viewer's response/file isolation, demotion, quotas,
pagination, capability-off, AI/Connections denial before external requests,
realtime attribution/revalidation, current-version races and reused version IDs.
Dashboard coverage includes selection, preview errors, partial deletion outcomes,
and audience controls. SDK requests and typed permission errors are covered.
Local browser checks exercised desktop/mobile confirmation, deletion of selected
history while retaining the live version, and persistence of audience settings.
