# Capabilities

Give a canvas a backend, one feature at a time, and know exactly when a call
from the page will work. This page is for a canvas's owner or editor. A canvas
is static until you switch **Enable backend** on in its **Backend** tab. With
the backend on, five features toggle independently: KV, files, AI, realtime, and
authoring. Identity (`me()`) has no toggle; it is on whenever the backend is on.
Outbound Connections also has no owner-controlled feature toggle: each reusable
profile is granted to the canvas by an instance administrator and remains gated
by the same Backend master switch.

## Turn on the backend

1. Open the canvas and go to the **Backend** tab.
2. Switch **Enable backend** on. It is off by default. You can also set it when
   you create the canvas: **Enable backend (optional)** on the create page, or
   `"backendEnabled": true` on `POST /api/canvases` and `POST /api/canvases/paste`.
3. Check the feature toggles. **Key-value storage**, **File storage**, **AI**,
   and **Realtime** are on by default, so they go live as soon as the backend is
   on (where the instance supports them). **Authoring** starts off and stays off
   until you turn it on.

Then call the features from the page through `window.canvasdrop`. No keys, no
setup:

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  const me = await canvasdrop.me();                 // on whenever the backend is on
  await canvasdrop.kv.set("last-viewer", me.name);  // needs Key-value storage on
</script>
```

Agents and scripts flip the same switches. The MCP tool `set_capabilities` and
`PATCH {base}/api/canvases/{id}/capabilities` take the same body: any subset of
`backendEnabled`, `kv`, `files`, `ai`, `realtime`, `authoring` as booleans.
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
| Key-value storage | `kv` | on | Shared and per-viewer JSON storage, atomic increment | [`kv`](/docs/sdk/kv) |
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

KV and files have no instance switch: your two toggles are the whole story.
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
