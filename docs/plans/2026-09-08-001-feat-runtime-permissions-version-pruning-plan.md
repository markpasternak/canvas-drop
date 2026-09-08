---
title: Participant permissions and version cleanup
execution: code
---

# Goal

Ship one unmerged PR containing bulk version cleanup, canvas-scoped identity and
permissions, and a runtime model where viewers contribute their own input while
owners and editors control shared content. Update all active reference docs,
examples, generated docs and SDK/MCP contracts affected by the change.

## Approved product contract

- Owners and editors can delete individual or selected historical versions, or all
  previous versions, after seeing a deduplicated estimate of reclaimable bytes.
  The current version, surviving history, draft and active upload references are
  protected. Deletion reports per-version outcomes; failed cleanup must never be
  presented as verified bytes recovered. Snapshots are not edited in place.
- A canvas's identity response exposes its effective owner/editor/viewer role and
  concrete permissions. These are derived from the live server-side principal and
  access decision, including team and general-access viewers. No admin bypass.
- Viewers read shared content, save personal preferences, and submit their own
  votes/forms. Owners/editors change shared content and review/manage submissions.
  Other viewers cannot see personal submissions. Published aggregates use shared KV.
- Shared KV mutations are editor/owner-only; private KV remains caller-only.
  A dedicated submissions namespace supports caller-scoped upsert/read/delete and
  editor review/delete. Ownership never comes from a submitted user id.
- Shared file mutations are editor/owner-only. Participant file uploads are private
  submissions, visible to their uploader and canvas editors/owner. Existing files
  remain shared. File permissions are enforced for listing, content and deletion.
- AI and Connections each have an explicit canvas audience (editors, or all signed-in
  viewers), default editors. Capability switches, admin connection grants, existing
  quotas and public/static-only rules remain authoritative.
- Realtime shared channels permit owner/editor publishing; participant channels
  permit attributed viewer messages. Live role revocation also applies to sockets.
- Dashboard settings and pruning have HTTP/MCP parity through shared services.
  Runtime SDK surfaces document allowed operations and typed permission failures.
- Existing canvas data is preserved. Runtime behavior changes are documented as a
  deployment migration concern; no production inventory, migration execution,
  merge or deployment is authorized in this round (user-directed).

## Implementation units

### U1: Prune version history

Extend the version-history service with a selection preview and bounded bulk
operation. Resolve selections at preview time and send explicit version numbers
at confirmation, so new publishes cannot enter an already approved deletion set.
Use the existing atomic non-current delete predicate, sweep once per batch, and
share previews and deletion behavior between management and MCP. Add accessible
selection controls, preview/loading/failure states and partial-result feedback.

Verification: both dialects; unique hashes shared across selected versions counted
once; remaining version/draft/upload hashes excluded; current/missing/racing
versions skipped; no-data and empty/invalid selection; one GC per batch; UI confirm
is tied to the selected snapshot; editor parity and viewer rejection.

### U2: Runtime roles and policy

Create a shared server-derived runtime permission projection and guards. Thread
live role through runtime HTTP and realtime; retain management roles separately.
Add additive dual-dialect audience/file-scope fields and generated migrations.
Expose audience settings in the dashboard, HTTP and MCP. Implement shared KV and
file rules, role-aware identity and realtime publishing scopes.

Verification: owner/editor/direct viewer/team viewer/org viewer/stranger; disabled
capability; public static-only; password and lifecycle gates; forged identity;
demotion/revocation; file content/list/delete isolation; AI and outbound audience
rejection before provider/network work; additive migration preserves stored data.

### U3: Participant submissions and SDK

Use a distinct internal KV scope for submissions with server-derived author keys,
bounded collection/value/key sizes and paginated author/reviewer access. Reuse
service behavior wherever exposed. Provide SDK methods, role/permission types and
examples for a poll and form; individual responses stay private until editors
publish a shared result. Keep private preferences separate from reviewable input.

Verification: submitting/updating/withdrawing one's response, owner/editor review
and delete, cross-user/canvas rejection, pagination, quotas, malformed keys/cursors,
capability off and role revocation. SDK request/response tests.

### U4: Documentation and delivery

Update BUILD_BRIEF, current project status/agent pointers, README where relevant,
HTTP/SDK/MCP references, capability/identity/storage/realtime/Connections guides,
examples and generated /docs, /llms.txt and skill bundle inputs. Include an operator
migration note describing affected patterns; explicitly defer live inventory.
Review the branch and fix substantive findings. Run lint, typecheck, both dialects,
dashboard tests, docs freshness, full build, desktop/mobile browser checks, then
open a single PR and leave it unmerged with CI results.

## Verification and completion

All units implemented; targeted rejection/edge tests and full local gates green;
code review completed and findings resolved; docs generated and fresh; UI inspected;
one PR with green required CI or a precise external blocker. No merge or deployment.

## Implementation record

U1, U2 and U3 are implemented with separate commits and passing local gates.
U4 includes the active docs site, generated docs/llms content, skill bundle input,
operator upgrade guide and updated runnable examples. The sequential review found
and fixed viewer-specific file-list caching, stale public-backend guidance and
unused transitional helpers. It added live team-role and active-upload GC tests.
Browser checks covered 1200px desktop and 390px phone layouts, selected history
removal/current preservation, and audience settings after reload. The participant
example saved a question, vote and feedback, then reviewed feedback and published
the expected vote totals through the SDK against a temporary local instance.

Final local validation: lint, typecheck, 3,111 server tests across SQLite and
PostgreSQL, 750 dashboard tests, generated-doc freshness and production build.
The existing four environment-dependent server tests remain skipped locally;
CI's real PostgreSQL/MinIO leg supplies its normal external-driver coverage.
The PR remains unmerged and undeployed; production inventory is deferred.
