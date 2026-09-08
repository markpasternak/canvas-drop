# Permissions and defaults

Canvas roles are **owner**, **editor** and **viewer**. A viewer can participate
without permission to change the canvas's code or manage its versions. Identity,
authorship and authorization come from the server. Hiding a button is only UI.

## Start with a default

In **Backend → Participation and permissions**, choose **Read only**,
**Participation** or **Collaboration**, then add the named resources used by your
canvas. A new collection or standalone file group receives the corresponding
Managed content, Shared contributions or Collaborative content preset. A new
channel allows everyone to receive messages; Read only restricts publishing to
owners/editors, while the other defaults allow participant publishing.

Defaults apply when you add resources. Changing the default does not rewrite
existing policies. Expand **Advanced permissions** only to change a preset or
customize an operation. Review the affected resources and save. Changes to an
existing resource affect its existing items immediately. Private preferences
remain private; AI, Connections and authoring have separate controls.

## Data and file presets

| Preset | Read | Create | Update/delete |
|---|---|---|---|
| Personal (`personal`) | Author | Participants | Author |
| Private submissions (`submissions`) | Author and owners/editors | Participants | Author and owners/editors |
| Shared contributions (`contributions`) | Participants | Participants | Author and owners/editors |
| Managed content (`managed`) | Participants | Owners/editors | Owners/editors |
| Collaborative content (`collaborative`) | Participants | Participants | Participants |

Participants means people admitted to this canvas's authenticated backend.
Public-link viewers remain static-only. An owner/editor does not automatically
read Personal records or `kv.user` preferences. Update, delete and increment also
require read access. Increment initially follows the preset's update right.

Advanced rights are `none`, `own`, `editors`, `own_and_editors`, and `viewers`.
Create uses only `none`, `editors`, or `viewers`: the server assigns authorship.
File update means rename; replacing bytes requires a new upload. Exports use the
same read/download permissions as the individual items. Bulk deletion only removes
records the caller can read and delete.

## Configure through the API or MCP

Read the canvas using the management API or MCP `get_canvas`. Send its exact
`runtimePolicyRevision` as `expectedRuntimePolicy` with your full policy document
to `PATCH /api/canvases/{id}/capabilities` or MCP `set_capabilities`. The initial
revision is `null`. Preserve existing entries when adding resources.

```json
{
  "expectedRuntimePolicy": null,
  "runtimePolicy": {
    "defaultMode": "participation",
    "collections": {
      "comments": { "preset": "contributions" },
      "answers": { "preset": "submissions", "aggregateCount": "editors" },
      "settings": { "preset": "managed" }
    },
    "fileGroups": { "uploads": { "preset": "contributions" } },
    "channels": {
      "activity": {
        "subscribe": "viewers", "publish": "viewers",
        "seePresence": "viewers", "participatePresence": "viewers"
      },
      "updates": {
        "subscribe": "viewers", "publish": "editors",
        "seePresence": "viewers", "participatePresence": "viewers"
      }
    },
    "connections": { "catalog": { "audience": "viewers", "methods": ["GET", "HEAD"] } }
  }
}
```

The API requires explicit presets and channel rights; `defaultMode` is the
starting choice for resource creation in the dashboard, not a wildcard grant.
Missing/stale revisions produce `POLICY_CONFLICT` (HTTP 409). Reload, reconcile
and review before retrying. A policy document contains at most 50 entries per
resource type. Names use 1–80 ASCII letters/digits/dots/colons/underscores/hyphens,
starting alphanumeric; object-prototype names are reserved. Unknown fields and
rights are rejected. Removing a resource's policy never deletes its stored data;
unconfigured collections/file groups become inaccessible.

To override only deletion, for example:

```json
{ "preset": "contributions", "overrides": { "delete": "editors" } }
```

Only owners/editors configure policies. Runtime callers select a resource name;
they cannot declare its policy or choose their author identity in a request.

## Authored collection records

Collections are part of KV, using reserved internal scopes. First configure the
collection, then use `kv.collection(name)`:

```js
const comments = canvasdrop.kv.collection("comments");
const comment = await comments.create({ text: "Clarify the chart", status: "open" });
// { id, authorId, value, updatedAt } — authorId is immutable, assigned by the server.
await comments.update(comment.id, { ...comment.value, status: "fixed" });
const page = await comments.list({ limit: 100 });
const rights = await comments.permissions();
// rights.update.own / rights.update.any; inspect me().id against record.authorId.
await canvasdrop.files.upload(file, { collection: "comments", recordId: comment.id });
```

| Method | Result |
|---|---|
| `create(value)` | New record; multiple records per author |
| `get(id)` | Record or null if absent/inaccessible |
| `update(id, value)` | Updated record; author unchanged |
| `delete(id)` | Delete a permitted record and clean up its attachments |
| `list({limit?, cursor?})` | `{entries, nextCursor}` filtered before pagination |
| `clear()` | `{deleted, attachmentCleanupFailed}` for permitted records only |
| `increment(id, by = 1)` | Updated numeric record; atomic, requires increment permission |
| `permissions()` | Effective read/create/update/delete/increment rights, each `{own, any}` |
| `count()` | Total record count, only if `aggregateCount` explicitly permits it |

Values are JSON including null, with a 64 KiB request limit. Pagination defaults
to 100, accepts 1–1000 and uses the opaque returned cursor. The existing admin KV
limits apply separately across authored collections: 10,000 records per canvas
and 1,000 per author by default. Creation limits are best-effort under concurrent
requests, like existing KV quotas. Updates at the limit remain available.

Count is opt-in and reveals only the collection size. It does not publish private
answers or arbitrary field aggregates. For votes, store authored responses and
publish a validated result through managed data; allowing a shared counter
increment is not a one-vote-per-person rule. The existing `submissions` convenience
API remains useful for one private response per person per collection.

## Files and realtime

`files.upload(file, {group: "uploads"})` uses a standalone file-group policy.
An attachment's read and mutation rights come from its parent record, rather than
the uploader. Uploading requires permission to read and update the parent. A
deleted or inaccessible parent makes the attachment unavailable, including its
direct content URL. Record deletion cleans attached metadata and attempts blob
cleanup; failed metadata cleanups are counted in the HTTP result. Blob cleanup is
best-effort and logged, never a measured-space guarantee.

Channel rights independently control receiving, publishing, seeing presence and
appearing in presence. All use `none`, `editors`, or `viewers`. Every operation
revalidates live roles and receiver policies. For unconfigured legacy channels,
everyone admitted can subscribe and use presence; only owners/editors publish,
except `participants:` channels, which allow participant publishing. A configured
channel's policy takes precedence over that prefix. KV changes do not automatically
broadcast data; never publish private records to a shared channel.

## AI, Connections, identity and authoring

AI chat and streaming share `aiAudience` (`editors` or `viewers`), with existing
model and budget restrictions. Per-Connection `audience` and optional `methods`
override the canvas audience and intersect with the live administrator grant.
Omit `methods` to retain all administrator-approved methods; `[]` allows none.
An operation's HTTP method is not proof of upstream ownership: the external
service must enforce its own item permissions. Credentials stay server-side.

`me()` exposes `canvasRole`, broad `permissions`, and effective named `resources`
for collections, file groups, channels and granted Connections. The boolean
`permissions.canCreateCanvas` describes enabled page-driven authoring for a member;
it does not grant edit/publish rights over an existing canvas. Those rights remain
subject to management role and target-canvas checks. Resource permissions are
UI hints; every operation rechecks authority, and quotas can still reject it.

Existing raw shared KV and shared files retain owner/editor mutation gates;
`kv.user` stays caller-only. See the [upgrade guide](/docs/self-hosting/runtime-upgrade)
before adapting existing canvases. No new arbitrary server-side code or custom
permission-expression language is introduced.
