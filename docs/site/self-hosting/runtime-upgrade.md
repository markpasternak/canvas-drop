# Upgrading runtime permissions

This release changes what existing canvas viewers can do. It preserves stored
canvases, versions, KV and files. Prepare affected canvases before deploying it.
Live inventory and deployment are separate operator steps; the implementation PR
does not inspect, modify or deploy production canvases.

| Existing pattern | New behavior | Preparation |
|---|---|---|
| Viewers write shared KV or increment a vote counter | Shared mutations require owner/editor; viewers receive `PERMISSION_DENIED`. | Move votes/forms to `submissions`; keep personal preferences in `kv.user`. Editors publish shared results. |
| Viewers upload shared files or delete any file | Shared mutations require owner/editor. | Upload participant attachments with `{ scope: "submission" }`. Existing file rows default to shared and keep their bytes. |
| Viewers call AI | `aiAudience` defaults to `editors`. | Deliberately set `aiAudience: "viewers"` where participation requires AI. Legacy guest opt-in/caps still apply. |
| Viewers call Connections | `connectionsAudience` defaults to `editors`. | Set `connectionsAudience: "viewers"` only for profiles intended for audience use. Existing admin grants remain required. |
| Viewers publish on ordinary realtime channels | Only owner/editor can publish there. | Use `participants:` for attributed viewer events. Keep authoritative/shared updates on ordinary channels; keep private answers in submissions. |
| Canvas code hides editing buttons using local state | UI state grants no authority. | Render controls from `me().canvasRole` / `permissions` and handle `PERMISSION_DENIED`. |

The additive migrations add `canvases.ai_audience`,
`canvases.connections_audience` (both default `editors`) and `files.scope`
(default `shared`) on SQLite and PostgreSQL. Submissions use a reserved scope in
the existing KV table. Deploying the server runs its normal pending migrations;
no backfill of existing answer data is automatic. Existing shared response data
remains shared until an owner deliberately changes the app and migrates/removes
that data. Restoring old version files does not restore old permission behavior
or roll back live backend data.

The SDK URL remains `/sdk/v1.js` and is normally cached for one hour. During
rollout purge its CDN cache if present and reload clients with a fresh SDK before
publishing canvases that call `submissions`. An already open page keeps its loaded
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
can submit only their own input, and another viewer cannot read that input or its
attachments. Open a socket, demote an editor, and verify shared publishing stops.
Check version cleanup against actual remaining history; its space number is an
estimate, not measured recovery. Monitor for the first hour and the next normal
usage day; the deploying operator owns the checks.

If a required workflow breaks, first correct the app or its explicit audience
policy. Pause rollout for unexplained access or privacy failures. Restoring the
old server can reintroduce broad viewer mutation permissions; do not treat that
as a privacy-preserving rollback. Back up before rollout and use the normal
[deployment](/docs/self-hosting/deploy) and backup procedures. No destructive
schema rollback is required for these additive columns.
