# Capabilities

A canvas is static by default. To give it backend behaviour, the owner turns on
capabilities on the canvas's **Backend** tab. They are off until you enable
them, and any SDK call to a feature that is off throws a
`CapabilityDisabledError` (code `CAPABILITY_DISABLED`).

## Turn on the backend

1. Open the canvas, go to the **Backend** tab.
2. Under **Backend**, switch **Enable backend** on. This is the master switch,
   off by default.
3. With the backend on, toggle the features you need: **KV**, **Files**, **AI**,
   **Realtime**. Each is independent.

**Identity has no toggle.** `me()` is available exactly when the backend is on;
the tab shows it as "Always on" once you enable the backend.

## The five primitives

| Capability | What it gives the canvas | SDK |
|-----------|--------------------------|-----|
| Key–value | Shared and per-viewer JSON storage, atomic increment | [kv](/docs/sdk/kv) |
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
story. AI and Realtime each carry an extra operator gate, so a feature you've
turned on can still report as off if the instance isn't set up for it. When that
happens, the toggle stays on but the tab labels it **"Disabled by your
administrator for this instance"** — so you can see *why* a feature you've
enabled is still off.

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
