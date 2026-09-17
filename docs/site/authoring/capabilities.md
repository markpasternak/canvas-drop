# Capabilities

Give a canvas a backend, one feature at a time, and know exactly when a call
from the page will work. This page is for a canvas's owner or editor. A canvas
is static until you switch **Enable backend** on in its **Backend** tab. With
the backend on, five features toggle independently: KV, files, AI, realtime, and
authoring. Identity (`me()`) has no toggle; it is on whenever the backend is on.
Outbound Connections also has no owner-controlled feature toggle: each reusable
profile is granted to the canvas by an instance administrator and remains gated
by the same Backend master switch.

## How features and resources fit together

The six runtime **primitives** are backend features. Three support named resources
with their own settings: **Key-value storage → collections** of authored records,
**File storage → file groups** of standalone uploads, and **Realtime → channels**
for messages and presence. Each collection, group or channel can have different
permissions. A policy controls access to a resource; it does not define which
records belong to it. Attachments inherit their parent record's permissions.

AI uses audience and budget settings, Connections uses per-profile audience/method
rules within administrator grants, and Identity reports the caller's role and
rights. Authoring is a separate capability for creating other canvases.

Enable the feature first, then configure the resources your app uses and reference
their names in its code. Adding a `comments` collection configures its access;
the app still implements commenting and creates the records. For simple settings
or private preferences, the data feature also provides fixed shared and personal
key-value scopes. Start with [Data storage](/docs/sdk/kv) and
[Permissions and defaults](/docs/sdk/permissions).

## Turn on the backend

1. Open the canvas and go to the **Backend** tab.
2. Switch **Enable backend** on. It is off by default. You can also set it when
   you create the canvas: **Enable backend (optional)** on the create page, or
   `"backendEnabled": true` on `POST /api/canvases` and `POST /api/canvases/paste`.
3. Check the feature toggles. **Key-value storage**, **File storage**, **AI**,
   and **Realtime** are on by default, so they go live as soon as the backend is
   on (where the instance supports them). **Authoring** starts off and stays off
   until you turn it on.

Then call the features from the page through `window.canvasdrop`, without browser
secrets. The simple personal-storage example needs no named resource:

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  const me = await canvasdrop.me();                 // on whenever the backend is on
  await canvasdrop.kv.user.set("last-visit", Date.now());  // needs Key-value storage on
</script>
```

Agents and scripts flip the same switches. The MCP tool `set_capabilities` and
`PATCH {base}/api/canvases/{id}/capabilities` take the same body: any subset of
`backendEnabled`, `kv`, `files`, `ai`, `realtime`, `authoring` as booleans,
and the audience fields described below.
Omitted fields are unchanged.

```json
{ "backendEnabled": true, "realtime": false }
```

The response is the canvas view. Every canvas view (the management API and the
MCP `get_canvas` tool included) carries two objects: `capabilities` (what is
stored) and `effective` (what runs right now, after the instance switches
below are applied).

Owners and editors can change capabilities; viewers cannot. Every change is
audited (`capabilities_update`, with the list of changed fields) and applies on
the next request. Turning the backend or realtime off also drops the canvas's
live realtime sockets. A canvas an admin has disabled refuses the change with
`409 DISABLED`.

## The toggles

| Backend tab row | Key | Stored default | What it gives the canvas | SDK |
|---|---|---|---|---|
| Enable backend | `backendEnabled` | off | The master switch; nothing below runs without it | |
| Identity (no toggle) | `identity` | follows the backend | The signed-in viewer: id, email, name, avatar | [`me()`](/docs/sdk/identity) |
| Key-value storage | `kv` | on | Shared values, private preferences and authored collections | [`kv`](/docs/sdk/kv) |
| File storage | `files` | on | Upload, list, delete, and serve files | [`files`](/docs/sdk/files) |
| AI | `ai` | on | Server-side model calls; no provider key in the page | [`ai`](/docs/sdk/ai) |
| Realtime | `realtime` | on | Ephemeral pub/sub and presence over WebSockets | [`realtime`](/docs/sdk/realtime) |
| Connections | no feature flag | no grants | Bounded requests to exact HTTPS origins an admin attached to this canvas | [`connections`](/docs/sdk/connections) |
| Authoring | `authoring` | off | A signed-in viewer creates and manages canvases from the page, as themselves | [`canvases`](/docs/sdk/authoring) |

The feature toggles are disabled in the UI while the backend is off. Their
stored values are kept, so switching the backend back on restores the same set.
The Identity row reads **Always on** when the backend is on and **Off** when it
is not.

## When a feature is effective

A feature runs only when every gate in its row is open: the backend, its own
toggle, and (for AI, realtime, and authoring) an instance switch the operator
controls. The server applies this rule on each request; the Backend tab shows
the outcome, and `effective` in the API is the same answer.

| Feature | Backend on | Its toggle on | Instance switch |
|---|---|---|---|
| Identity (`me()`) | yes | none | none |
| KV | yes | yes | none |
| Files | yes | yes | none |
| AI | yes | yes | An AI provider key is configured: `CANVAS_DROP_AI_API_KEY`, or the **Provider API key** an admin sets in Admin → Settings |
| Realtime | yes | yes | `CANVAS_DROP_REALTIME=on` (the default) |
| Connections | yes | an enabled profile is attached | `CANVAS_DROP_CONNECTIONS_ENCRYPTION_KEY` is available when protected headers are configured |
| Authoring | yes | yes | `CANVAS_DROP_AUTHORING=on` (default `off`), or **Authoring enabled** set by an admin in Admin → Settings |

KV and files have no instance switch. Their toggles enable the feature; the
caller still needs the role required by the operation.
When your toggle is on but the instance switch is off, the toggle stays on and
the row is labelled **Disabled by your administrator for this instance.** The
AI key and the authoring switch are read per request, so an admin's change
applies immediately. Realtime follows `CANVAS_DROP_REALTIME` as set when the
server started; the admin panel shows it but cannot change it.

## Limits

Each feature has fixed ceilings. Exceeding one returns the error named in the
last column, not `CAPABILITY_DISABLED`; see [error codes](/docs/api/errors).

| Feature | Limit | Admin-adjustable | Error |
|---|---|---|---|
| KV | 64 KB per value, 512 bytes per key; 10 000 shared keys and 1 000 per-viewer keys per canvas | the key counts | `VALUE_TOO_LARGE`, `KEY_TOO_LARGE`, `KEY_LIMIT` |
| Files | 25 MB per file, 1 GB per canvas | both | `FILE_TOO_LARGE`, `QUOTA_EXCEEDED` |
| AI | Models on the allowlist (`CANVAS_DROP_AI_MODELS`); spend caps of `CANVAS_DROP_AI_USER_DAILY_USD` (default `5`) per viewer per day and `CANVAS_DROP_AI_CANVAS_MONTHLY_USD` (default `50`) per canvas per month | allowlist and both caps | `MODEL_NOT_ALLOWED`, `QUOTA_EXCEEDED` |
| Realtime | 30 concurrent connections per canvas, 16 KB per message | no | `CONNECTION_LIMIT` (socket close `4429`) |
| Connections | 8 KiB URL; 32/16 KiB caller headers; 256 KiB request; 2 MiB response; 10 s; 3 redirects; 60/min actor+canvas+profile; 600/min profile; 5 concurrent/canvas; 50/process | env-only | `REQUEST_TOO_LARGE`, `RESPONSE_TOO_LARGE`, `UPSTREAM_TIMEOUT`, `CONNECTION_RATE_LIMIT`, `CONNECTION_LIMIT` |

## When a feature is off

A call to a feature that is off fails with a `403` whose body names the gate
that failed:

```json
{
  "code": "CAPABILITY_DISABLED",
  "capability": "kv",
  "backendEnabled": false,
  "reason": "backend_off",
  "hint": "This canvas's backend is off (the master switch, off by default). Turn it on in the dashboard Backend tab, the set_capabilities MCP tool, or PATCH /api/canvases/:id/capabilities {\"backendEnabled\": true}."
}
```

`reason` is `backend_off`, `feature_off`, or `operator_disabled`; `hint` says
what to turn on. The SDK throws a `CapabilityDisabledError`
(`err.code === "CAPABILITY_DISABLED"`, `err.status === 403`) and exposes the
server hint as `err.hint`, which is also the error message:

```js
try {
  await canvasdrop.kv.set("count", 1);
} catch (err) {
  if (err.code === "CAPABILITY_DISABLED") console.log(err.hint);
  else throw err;
}
```

Realtime reports the same condition over the socket: a connection opened while
realtime is off receives one
`{ "type": "error", "code": "CAPABILITY_DISABLED", "capability": "realtime" }`
frame and is closed with code `4403`. A socket that is already open when
realtime is turned off is closed with `4403` too. The SDK turns both into the
same `CapabilityDisabledError` and does not reconnect. See
[error codes](/docs/api/errors) for the full list.

## Public links are static-only

On the **Public link** rung (`public_link`) the server serves the canvas's files
to anyone with the URL and refuses every primitive with `403 STATIC_ONLY` for
everyone except the canvas's owner and editors. Signed-in org members are
refused too. The Backend tab shows a warning when a public-link canvas has its
backend on. If the canvas needs a backend for its audience, share it on a more
restricted rung; see [Sharing & access](/docs/authoring/sharing).

## Authoring

Authoring lets a signed-in org member viewing your canvas create a new canvas
from the page, as themselves, through `canvasdrop.canvases.publish(...)`. The
new canvas is created under the viewer's own account and appears in their
dashboard; they can `update`, `list`, and `revoke` it later. Legacy guest
sessions and public-link visitors cannot use it.

Because it mints canvases, authoring is the one feature whose stored flag starts
off, and its instance switch (`CANVAS_DROP_AUTHORING`) is off by default as
well. The operator also sets the policy a publish is checked against:

| Policy | Env var | Default |
|---|---|---|
| Canvases one viewer may publish per day | `CANVAS_DROP_AUTHORING_USER_DAILY_MAX` | `20` |
| Canvases one viewer may publish in total | `CANVAS_DROP_AUTHORING_USER_TOTAL_MAX` | `200` |
| Access rungs a publish may request | `CANVAS_DROP_AUTHORING_ALLOWED_RUNGS` | `private,specific_people,whole_org,public_link` |
| Longest allowed share expiry, in days | `CANVAS_DROP_AUTHORING_MAX_EXPIRY_DAYS` | `0` (no cap) |
| Whether a share expiry is required | `CANVAS_DROP_AUTHORING_REQUIRE_EXPIRY` | `false` |

An admin can change the two quotas at runtime in Admin → Settings; the rung and
expiry policy is env-only (`specific_people` is a legacy alias of `private`). Requiring
an expiry applies only to **Whole org** and **Public link** publishes. Restricted
publishes (`private`, `specific_people`, or `team`) do not require one. See the
[authoring SDK reference](/docs/sdk/authoring).

## Clones start static

Duplicating a canvas, or using a gallery template, creates a new canvas with the
backend off and the feature flags at their defaults (KV, files, AI, and realtime
on; authoring off). KV data, files, and usage are not copied. The new owner
turns the backend on when they need it.

## Why off by default

Capabilities are enforced by the server, per request, from the signed-in
session: the canvas can ask, the server decides. Canvas files never carry a
secret, and a static canvas has no backend surface at all. Turning a capability
on is normally a per-canvas choice its owner or an editor makes. Connections is
the deliberate exception: only an admin defines profiles and attaches or revokes
their grants, while owners and editors inspect the non-secret authority in the
Backend tab.

## Who can use the backend

Feature switches control availability; canvas roles control each operation.
Raw shared KV and shared files require owners/editors for mutations. Configured
collections and file groups support Personal, Private submissions, Shared
contributions, Managed content and Collaborative content. Viewers can contribute
and manage their own records without permission to edit the canvas itself.
[`me().permissions` and `me().resources`](/docs/sdk/identity) report effective rights.
A denied operation returns `PERMISSION_DENIED`.

**Participation and permissions** starts with a default for new resources:
Read only, Participation or Collaboration. Add a named collection, file group or
channel using that default. Expand **Advanced permissions** only when a resource
needs a different preset or operation-level rights. Review the affected resources
before saving. Changing the default preserves existing policies. Attachments inherit
their record's policy. [Full policy and API guide](/docs/sdk/permissions).

The Backend tab also has **AI access** and **Connection access**, each set to
**Owners and editors** by default. Choose **All signed-in viewers** to permit
an interactive audience to use that backend. **Authoring access** works the same
way for page-driven authoring, but defaults to **All signed-in viewers** so
existing canvases keep working; choose **Owners and editors** to limit creating,
updating, listing and unpublishing shares from this page to the canvas's
managers. Public links remain static-only for viewers. An audience choice cannot
enable a disabled feature, supply an AI key, grant a Connection profile, or
bypass quotas and legacy guest restrictions.

`PATCH /api/canvases/{id}/capabilities` and MCP `set_capabilities` accept
`aiAudience`, `connectionsAudience` and `authoringAudience`, each `"editors"` or
`"viewers"`. The management canvas view exposes all three alongside
`capabilities` and `effective`.
Omitted values stay unchanged. Only owners and editors can change them.
The same endpoint and MCP tool accept `runtimePolicy` plus the exact previous
`runtimePolicyRevision` as `expectedRuntimePolicy` (initially null). A stale or
missing revision returns `POLICY_CONFLICT`. Per-Connection policies can override
the default audience and narrow methods; administrator grants still bound them.

```json
{ "backendEnabled": true, "ai": true, "aiAudience": "viewers", "connectionsAudience": "editors", "authoringAudience": "editors" }
```

For an existing installation, read the [runtime upgrade guide](/docs/self-hosting/runtime-upgrade)
before deploying these defaults.
