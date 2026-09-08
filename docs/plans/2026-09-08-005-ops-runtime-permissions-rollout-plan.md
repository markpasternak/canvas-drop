---
title: Deploy runtime permissions and preserve existing canvas intent
execution: code
---

The user authorized merge, deployment and canvas migration, then explicitly
allowed the admin merge override. PR #117 passed every CI check and merged as
048f1ed. This supersedes the initial preparation-only scope of plans 001–004.

Refresh production inventory and prepare app/data changes from current versions.
Verify original authors from server audit evidence. Rehearse on an isolated copy,
then stop writes, back up the database and storage, verify integrity, switch the
built release and migrate data/policies before restarting. Keep rollback material.
Preserve existing roles, sharing, original content, attachment references and all
history; no compatibility mode or mass role promotion.

Verify identity, comment creation/status/deletion, cross-author denials, inherited
attachments, exports, realtime activity/presence and viewer Connections. Respect
existing password gates. Use temporary scoped QA identities and remove them after
verification. Fix observed failures, including stale browser SDKs, then record
results and update status/upgrade documentation through a follow-up PR.
