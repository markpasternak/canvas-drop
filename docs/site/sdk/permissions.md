# Permissions and defaults

Canvas roles are **owner**, **editor** and **viewer**. A viewer can participate
without permission to change the canvas's code or manage its versions. Identity,
authorship and authorization come from the server. Hiding a button is only UI.

## Features, resources and permissions

A **primitive** is a backend feature, such as data storage, files or realtime.
A **resource** is a named group inside one of those features. A **policy** is the
set of permissions attached to that resource.

| Resource type | Backend feature | What it groups | Example |
|---|---|---|---|
| Collection | [Data storage (KV)](/docs/sdk/kv#what-a-collection-is) | Authored JSON records | `comments`, `answers` |
| File group | [File storage](/docs/sdk/files#file-groups-and-attachments) | Standalone uploaded files | `documents` |
| Channel | [Realtime](/docs/sdk/realtime#channels-and-their-permissions) | Live messages and presence | `activity`, `presentation-navigation` |

Each named resource has its own settings. Two collections can share a preset
while containing separate records; changing a collection's policy changes access
to its records, not their membership or authorship. For example, use Shared
contributions for comments visible to all participants and Private submissions for
answers only their author and owners/editors can read.

Attachments inherit their parent record's permissions, so they do not need a
separate file group. AI has audience and budget controls, Connections has
per-profile audience/method rules, and Identity reports the caller's role and
effective rights. Those features do not use the three resource types above.

The canvas's code must use the configured resource names. Adding `comments` here
does not build a comment form or migrate existing shared keys. An owner/editor
configures the collection; the app creates its records through the runtime API.

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
Public-link viewers remain static-only except for an explicitly approved
[public Connection grant](/docs/sdk/connections#public-connections-opt-in).
An owner/editor does not automatically
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

A collection groups records with server-assigned IDs and immutable authorship.
Configure its policy here, then use `kv.collection(name)` in your canvas code.
See the [Data storage guide](/docs/sdk/kv#what-a-collection-is) for the model,
when to use collections, and the [complete collection API](/docs/sdk/kv#collection-api).

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
revalidates live roles and receiver policies. For unconfigured channels,
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
