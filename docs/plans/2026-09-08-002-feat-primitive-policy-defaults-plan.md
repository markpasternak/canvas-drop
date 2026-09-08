---
title: Primitive policies with easy defaults
execution: code
---

# Goal

Extend issue #116 / PR #117 in the existing isolated worktree. Preserve version
pruning. Deliver the user-approved primitive rights model, defaults, advanced
controls, SDK/API/MCP parity and relevant documentation. Do not merge or deploy.
This supersedes the narrower runtime design in plan 001; its pruning contract stands.

## Approved contract

Keep owner/editor/viewer canvas roles. Persist resource policies server-side.
Data and file presets: personal, private submissions, shared contributions,
managed content, collaborative content. Allow operation overrides using bounded
audiences (nobody, author, managers, author and managers, participants). Authorship
is immutable and server-derived. A record is the unit of update/delete authority.
Personal preferences remain caller-only. Private submissions remain available as
a compatibility convenience. New collection records support multiple items per author.

Canvas defaults: read only, participation, collaboration. Default changes initialize
new resources and never silently rewrite existing resource policies. Dashboard shows
the changed policy before save; optimistic concurrency rejects stale policy writes.
Advanced controls cover collection read/create/update/delete/increment, file groups,
channel subscribe/publish/see-presence/participate-presence, and per-Connection
audience/method restrictions. AI keeps one invocation audience and existing limits.
Authoring exposes effective creation rights while existing-canvas management keeps
its role gates. Identity reports role and effective resource permissions.

Attachments inherit record visibility and mutation rights; deleting their parent
makes content inaccessible. Standalone file groups use the data presets. Exports
follow read access. Batch operations obey individual record rights. Increment is a
write, not a vote permission. Private aggregates require explicit opt-in; provide
only count, with no arbitrary query language or private-value disclosure.
Realtime visibility is separate from publishing and presence; policies and live
roles apply to receiving as well as sending. No automatic private-record payloads.
Connections intersect canvas policy with administrator-approved methods/grants;
upstream ownership is still enforced upstream. Public/static-only gates remain.

## Units

1. Shared policy schemas, additive dual-dialect migration, immutable records,
   policy persistence/concurrency and runtime collection routes. Verify rejection,
   author spoofing, multiple records, filtering/pagination, quotas and atomic writes.
2. File inheritance/groups, realtime channel rights, Connection overrides and
   identity projection. Verify direct URLs, private managers, deletion, live policy
   revocation and no upstream invocation when forbidden.
3. Dashboard defaults and progressive advanced controls, management/MCP parity,
   browser SDK and runnable participant example. Verify stale edits, summaries,
   defaults preserving existing resources, role gates and request contracts.
4. Update canonical specification, active docs, examples and generated docs.
   Simplify/review, full lint/typecheck/dual-dialect/dashboard tests/build, browser
   desktop/mobile checks; update existing PR and obtain green CI.

## Execution

Native sequential main-thread execution per repository tool mapping. No unrelated
working changes at start; branch is already published and authorized for this PR.
Existing tests are retained as compatibility coverage; add focused rejection tests
before the first new collection implementation. Use full integration tests across
both dialects for authorization and persistence. No production mutations.
