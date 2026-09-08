# Upgrading runtime permissions

This release changes what existing canvas viewers can do. It preserves stored
canvases, versions, KV and files. Prepare affected canvases before deploying it.
The server migrations do not adapt deployed canvas code or infer record authors.
Operators must prepare and apply those changes explicitly.

There is one permission model. Upgrade each affected canvas to preserve its
intended interactions; do not grant participants editor access to work around
denied requests. Prepare the updated apps and data migration before the server
cutover, then apply their policies and validate them as part of the same rollout.

| Existing pattern | New behavior | Preparation |
|---|---|---|
| Viewers write shared KV or increment a vote counter | Raw shared mutations require owner/editor; viewers receive `PERMISSION_DENIED`. | Configure authored collections with Shared contributions or Private submissions. Keep preferences in `kv.user`; the one-response `submissions` convenience API remains available. |
| Viewers upload shared files or delete any file | Raw shared mutations require owner/editor. | Bind attachments using `{collection, recordId}` or configure a file group. Record authorship controls deletion. Existing file rows remain shared with their original bytes. |
| Viewers call AI | `aiAudience` defaults to `editors`. | Deliberately set `aiAudience: "viewers"` where participation requires AI. Legacy guest opt-in/caps still apply. |
| Viewers call Connections | `connectionsAudience` defaults to `editors`. | Prefer a per-profile policy permitting the required audience and methods. Existing admin grants remain required. |
| Viewers publish on ordinary realtime channels | Without explicit policy, only owner/editor can publish there. | Configure existing activity channels for participant publishing. Keep authoritative channels editor-published while everyone receives; never broadcast private answers. |
| Canvas code hides editing buttons using local state | UI state grants no authority. | Render controls from `me().canvasRole` / `permissions` and handle `PERMISSION_DENIED`. |

## Preserve application intent

For shared comments, use a Shared contributions collection: participants can
read and create; the author and owners/editors can update status or delete.
Export reads the same collection. Keep review-round settings in managed storage.
Create a comment record before uploading its attachments so each file can inherit
the parent record's rights. A policy alone cannot enforce author-only changes
inside an existing shared KV blob.

When migrating existing comments, preserve identifiers and references used by
review rounds, exports and attachments. Verify each original author's identity
against a trustworthy source; a display name or last updater is not proof of
authorship. The runtime create API always attributes records to its caller, so an
owner replaying other people's comments would assign the wrong author. Use a
controlled server-side migration with a reviewed mapping, preserve timestamps
and attachment associations, and verify counts and content against a backup.
Unresolved authorship must be reviewed before cutover rather than guessed.

For live activity, allow everyone with backend access to receive the relevant
channel. Decide publishing and presence independently: an activity channel may
allow participant publishing, while a presentation-control channel can reserve
publishing for owners/editors. Existing channel names can remain when explicitly
configured. Channel policies match exact names, not wildcard patterns. For
dynamic participant channels, use the `participants:` namespace or redesign them
around a fixed configured channel. Do not trust a local “presenter” switch as
authorization to control other viewers.

Version pruning is unrelated to the permission cutover. It only runs when
explicitly requested; upgrading does not remove history or reclaim storage.

## Data and rollout

The additive migrations add `canvases.ai_audience`,
`canvases.connections_audience` (both default `editors`) and `files.scope`
(default `shared`) on SQLite and PostgreSQL. Submissions use a reserved scope in
the existing KV table. The policy extension adds nullable `canvases.runtime_policy`,
`kv_entries.author_id` and `files.record_id`. No legacy author is inferred from
the last person to update a value. Authored records use new reserved `records:`
scopes; existing data requires a deliberate migration with trustworthy authorship.
Deploying the server runs its normal pending migrations;
no backfill of existing answer data is automatic. Existing shared response data
remains shared until an owner deliberately changes the app and migrates/removes
that data. Restoring old version files does not restore old permission behavior
or roll back live backend data.

The SDK URL remains `/sdk/v1.js` and is normally cached for one hour. During
rollout purge its CDN cache if present and reload clients with a fresh SDK before
publishing canvases that call `kv.collection`, use bound attachments, or inspect
resource permissions. Give affected script URLs a new release query, for example
`/sdk/v1.js?v=permissions-20260908`, so a normal reload avoids an old browser cache.
A CDN purge alone cannot invalidate a copy already cached in a browser. An already open page keeps its loaded
code until reload; changing server permissions takes effect immediately.

Before deployment, inventory enabled-backend canvases and inspect their authored
code for the patterns above. Include team/direct viewers, whole-org viewers and
retained guest sessions. A canvas author chooses which audience policies to opt
in; a capability switch alone does not do it. Public-link viewers remain
static-only. Verify a viewer and editor account against each affected app before
publishing its updated version.

After an approved deployment, check the access and application error signals for
`PERMISSION_DENIED`, `STATIC_ONLY`, `CAPABILITY_DISABLED`, failed form saves and
failed upstream calls. Confirm an owner/editor can edit shared content, a viewer
can create contributions and only update/delete their own, and private submissions
and personal data are hidden according to their presets. Check exports and direct
attachment URLs. Open a socket, demote an editor, and verify managed publishing stops
while allowed receiving continues. Test per-channel changes on existing sockets.
Check version cleanup against actual remaining history; its space number is an
estimate, not measured recovery. Monitor for the first hour and the next normal
usage day; the deploying operator owns the checks.

If a required workflow breaks, first correct the app or its explicit audience
policy. Pause rollout for unexplained access or privacy failures. Restoring the
old server can reintroduce broad viewer mutation permissions; do not treat that
as a privacy-preserving rollback. Back up before rollout and use the normal
[deployment](/docs/self-hosting/deploy) and backup procedures. No destructive
schema rollback is required for these additive columns.
