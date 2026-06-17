# Capabilities

Give a canvas backend behavior by turning on capabilities per canvas, on its
**Backend** tab. A canvas is static by default: the master switch and every
feature are off until you enable them, and any SDK call to a feature that is off
throws a `CapabilityDisabledError` (code `CAPABILITY_DISABLED`).

## Turn on the backend

1. Open the canvas and go to the **Backend** tab.
2. Switch **Enable backend** on. This is the master switch, off by default.
3. With the backend on, toggle the features you need: **KV**, **Files**, **AI**,
   **Realtime**. Each is independent. (The feature toggles stay disabled while
   the backend is off.)

Then call them from the page through `window.canvasdrop`. No keys, no setup:

```js
await canvasdrop.kv.set("count", 1);   // KV must be on
const me = await canvasdrop.me();      // available whenever the backend is on
```

**Identity has no toggle.** `me()` is available exactly when the backend is on;
the tab shows it as "Always on" once you enable the backend.

## The five primitives

| Primitive | What it gives the canvas | SDK |
|-----------|--------------------------|-----|
| KV | Shared and per-viewer JSON storage, atomic increment | [kv](/docs/sdk/kv) |
| Files | Upload, list, serve files | [files](/docs/sdk/files) |
| Identity | The signed-in viewer's id, email, name, avatar | [identity](/docs/sdk/identity) |
| AI | Server-side model calls, no provider key in the page | [ai](/docs/sdk/ai) |
| Realtime | Ephemeral pub/sub + presence | [realtime](/docs/sdk/realtime) |

## When a feature is effective

A feature is **effective** — usable from the SDK — only when every applicable
condition is true:

| Feature | Effective when |
|---------|----------------|
| Identity (`me()`) | Backend is on |
| KV | Backend on **and** KV toggle on |
| Files | Backend on **and** Files toggle on |
| AI | Backend on **and** AI toggle on **and** the operator has configured an AI provider key |
| Realtime | Backend on **and** Realtime toggle on **and** the operator has enabled realtime for the instance |

KV and Files have no operator-level switch: your two toggles are the whole
story. AI needs the operator to have configured an AI provider key; Realtime
needs the operator to have turned realtime on for the instance
(`CANVAS_DROP_REALTIME`). Each condition is resolved per request, so an admin
flipping the instance setting takes effect immediately. A feature you've turned
on can still report as off if the instance isn't set up for it: the toggle stays
on, but the tab labels it **Disabled by your administrator** so you can see
*why* it isn't running.

## Public links are static-only

If a canvas is shared as a **public link** (the `public_link` access rung,
anyone with the link), every primitive is inert for public visitors. The
Backend tab shows a warning that the canvas serves static files only, and
the server refuses backend calls from those visitors with `STATIC_ONLY`
(status 403). The backend still works for you and for signed-in org members; use
a more restricted access rung if the canvas needs a backend for everyone.

## What happens when a feature is off

The SDK throws at call time:

```js
try {
  await canvasdrop.kv.set("count", 1);
} catch (err) {
  // err is a CapabilityDisabledError, err.code === "CAPABILITY_DISABLED"
}
```

See [error codes](/docs/api/errors) for the full list.

## Why off by default

No secrets ever live in canvas files. Capabilities are server-enforced per
request from the signed-in session — the canvas can ask, but the server decides.
Turning a capability on is a deliberate choice the owner makes per canvas.

Cloning a canvas as a template starts with the backend **off**: clones are
static-first, and the new owner opts back in to whatever they need.
