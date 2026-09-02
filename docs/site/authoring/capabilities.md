# Capabilities

Give a canvas a backend, one feature at a time, and know exactly when a call
from the page will work. A canvas is static until its owner or an editor
switches **Enable backend** on in the canvas's **Backend** tab. With the backend
on, five features toggle independently: KV, files, AI, realtime, and authoring.
Identity (`me()`) has no toggle; it is on whenever the backend is on.

## Turn on the backend

1. Open the canvas and go to the **Backend** tab.
2. Switch **Enable backend** on. It is off by default. You can also set it when
   you create the canvas (**Enable backend (optional)** on the create page).
3. Check the feature toggles. **Key-value storage**, **File storage**, **AI**,
   and **Realtime** are pre-enabled, so they go live as soon as the backend is
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

Agents and scripts flip the same switches: the MCP tool `set_capabilities`, or
`PATCH {base}/api/canvases/{id}/capabilities` with any subset of
`backendEnabled`, `kv`, `files`, `ai`, `realtime`, `authoring` as booleans.
Omitted fields are unchanged. The response is the canvas view, which carries
both `capabilities` (what is stored) and `effective` (what actually runs).

Owners and editors can change capabilities. Every change is audited
(`capabilities_update`) and applies on the next request; turning the backend or
realtime off also drops live realtime sockets. A canvas an admin has disabled
refuses the change with `409 DISABLED`.

## The toggles

| Backend tab row | Key | Stored default | What it gives the canvas | SDK |
|---|---|---|---|---|
| Enable backend | `backendEnabled` | off | The master switch; nothing below runs without it | |
| Identity (no toggle) | `identity` | follows the backend | The signed-in viewer: id, email, name, avatar | [`me()`](/docs/sdk/identity) |
| Key-value storage | `kv` | on | Shared and per-viewer JSON storage, atomic increment | [`kv`](/docs/sdk/kv) |
| File storage | `files` | on | Upload, list, delete, and serve files | [`files`](/docs/sdk/files) |
| AI | `ai` | on | Server-side model calls; no provider key in the page | [`ai`](/docs/sdk/ai) |
| Realtime | `realtime` | on | Ephemeral pub/sub and presence over WebSockets | [`realtime`](/docs/sdk/realtime) |
| Authoring | `authoring` | off | A signed-in viewer creates and manages canvases from the page, as themselves | [`canvases`](/docs/sdk/authoring) |

The feature toggles are disabled in the UI while the backend is off. Their
stored values are kept, so switching the backend back on restores the same set.
The Identity row reads **Always on** when the backend is on and **Off** when it
is not.

## When a feature is effective

A feature runs only when every gate in its row is open. The server applies this
rule on each request; the Backend tab shows the outcome.

| Feature | Backend on | Its toggle on | Operator switch |
|---|---|---|---|
| Identity (`me()`) | yes | none | none |
| KV | yes | yes | none |
| Files | yes | yes | none |
| AI | yes | yes | An AI provider key is configured (`CANVAS_DROP_AI_API_KEY`, or set by an admin at runtime) |
| Realtime | yes | yes | `CANVAS_DROP_REALTIME=on` (the default) |
| Authoring | yes | yes | `CANVAS_DROP_AUTHORING=on` (default `off`; an admin can turn it on at runtime) |

KV and files have no operator switch: your two toggles are the whole story. When
your toggle is on but the operator switch is off, the toggle stays on and the
row is labelled **Disabled by your administrator for this instance.** The AI key
and the authoring switch are read per request, so an admin's change applies
immediately; realtime follows `CANVAS_DROP_REALTIME` as set when the server
started.

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
realtime is off receives one `{ "type": "error", "code": "CAPABILITY_DISABLED" }`
frame and is closed with code `4403`. The SDK turns that into the same
`CapabilityDisabledError` and does not reconnect. See
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
from the page, as themselves, through `canvasdrop.canvases.publish(...)`. The new
canvas is created under the viewer's own account and appears in their
dashboard; they can `update`, `list`, and `revoke` it later. Guests and
public-link visitors cannot use it.

Because it mints canvases, authoring is the one feature whose stored flag starts
off, and its operator switch (`CANVAS_DROP_AUTHORING`) is off by default as
well. The operator also sets the policy a publish is checked against:
per-viewer quotas (`CANVAS_DROP_AUTHORING_USER_DAILY_MAX`, default 20;
`CANVAS_DROP_AUTHORING_USER_TOTAL_MAX`, default 200), which access rungs may be
requested (`CANVAS_DROP_AUTHORING_ALLOWED_RUNGS`, default all four), and whether
a share expiry is required or capped (`CANVAS_DROP_AUTHORING_REQUIRE_EXPIRY`,
`CANVAS_DROP_AUTHORING_MAX_EXPIRY_DAYS`). See the
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
on is a per-canvas choice its owner or an editor makes.
