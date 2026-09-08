# Upgrading runtime permissions

This release changes what existing canvas viewers can do. It preserves stored
canvases, versions, KV and files. Prepare affected canvases before deploying it.
Live inventory and deployment are separate operator steps; the implementation PR
does not modify or deploy production canvases.

| Existing pattern | New behavior | Preparation |
|---|---|---|
| Viewers write shared KV or increment a vote counter | Raw shared mutations require owner/editor; viewers receive `PERMISSION_DENIED`. | Configure authored collections with Shared contributions or Private submissions. Keep preferences in `kv.user`; the one-response `submissions` convenience API remains available. |
| Viewers upload shared files or delete any file | Legacy shared mutations require owner/editor. | Bind attachments using `{collection, recordId}` or configure a file group. Record authorship controls deletion. Existing file rows remain shared with their original bytes. |
| Viewers call AI | `aiAudience` defaults to `editors`. | Deliberately set `aiAudience: "viewers"` where participation requires AI. Legacy guest opt-in/caps still apply. |
| Viewers call Connections | `connectionsAudience` defaults to `editors`. | Prefer a per-profile policy permitting the required audience and methods. Existing admin grants remain required. |
| Viewers publish on ordinary realtime channels | Without explicit policy, only owner/editor can publish there. | Configure existing activity channels for participant publishing. Keep authoritative channels editor-published while everyone receives; never broadcast private answers. |
| Canvas code hides editing buttons using local state | UI state grants no authority. | Render controls from `me().canvasRole` / `permissions` and handle `PERMISSION_DENIED`. |

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
resource permissions. An already open page keeps its loaded
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
