# Browser SDK

The browser SDK gives a canvas backend capability — key–value storage, file
storage, the signed-in viewer's identity, AI, and realtime — with **no build step
and no secrets in the canvas**. Identity comes from the signed-in session; the
canvas is identified by its own URL.

## Add it to a canvas

```html
<script src="/sdk/v1.js"></script>
```

That defines the global `window.canvasdrop`. The SDK auto-detects the canvas slug
and the API base from the page's location (path mode `/c/{slug}/…` or subdomain
`{slug}.{base}`) and sends every request with the session cookie.

> `/sdk/v1.js` is served to signed-in canvas pages — it rides the same session as
> the canvas. The stable `/sdk/v1.js` path is additive and backward-compatible
> within v1, so pointing a `<script>` at it means you receive fixes (including
> security patches) without redeploying. A breaking change would ship under a new
> path (`/sdk/v2.js`).

## Enable the capability first

The canvas owner must turn on **Backend** (and the specific feature) in the
canvas's **Capabilities** tab. A method whose capability is off throws a
`CapabilityDisabledError`. See [Capabilities](/docs/authoring/capabilities).

## The surface

- [`canvasdrop.me()`](/docs/sdk/identity) — the signed-in viewer.
- [`canvasdrop.kv`](/docs/sdk/kv) — shared and per-viewer key–value storage.
- [`canvasdrop.files`](/docs/sdk/files) — file upload, list, serve.
- [`canvasdrop.ai`](/docs/sdk/ai) — server-side model calls.
- [`canvasdrop.realtime`](/docs/sdk/realtime) — pub/sub + presence.

## Errors

Every failure throws a typed error extending `CanvasdropError`, each carrying a
stable `.code` and `.status`. See the [error code reference](/docs/api/errors).

```js
try {
  await canvasdrop.kv.increment("votes");
} catch (err) {
  if (err.code === "CAPABILITY_DISABLED") {
    // ask the owner to enable KV in the Capabilities tab
  } else {
    throw err;
  }
}
```

If you import `@canvas-drop/sdk` as a module instead of the global script, the
error classes are exported for `instanceof` checks.
