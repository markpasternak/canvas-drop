# Browser SDK

The browser SDK gives a canvas backend capability — key–value storage, file
storage, the signed-in viewer's identity, AI, and realtime — with **no build step
and no secrets in the canvas**. Identity comes from the signed-in session; the
canvas is identified by its own URL.

## Add it to a canvas

```html
<script src="/sdk/v1.js"></script>
```

That defines the global `window.canvasdrop` (no other global name). The SDK
auto-detects the canvas slug and the API base from the page's location — path mode
`/c/{slug}/…` (same origin) or subdomain `{slug}.{base}` — and sends every request
with `credentials: "include"`, so identity rides the existing session cookie. Each
call hits `{apiBase}/v1/c/{slug}/…`; you never pass the slug or any key yourself.

> `/sdk/v1.js` is served to signed-in canvas pages — it rides the same session as
> the canvas. The stable `/sdk/v1.js` path is additive and backward-compatible
> within v1, so pointing a `<script>` at it means you receive fixes (including
> security patches) without redeploying. A breaking change would ship under a new
> path (`/sdk/v2.js`).

## Enable the capability first

The canvas owner must turn on **Backend** (and the specific feature) in the
canvas's **Backend** tab. A method whose capability is off throws a
`CapabilityDisabledError`. See [Capabilities](/docs/authoring/capabilities).

## The surface

- [`canvasdrop.me()`](/docs/sdk/identity) — the signed-in viewer (`{ id, email, name, avatarUrl }`).
- [`canvasdrop.kv`](/docs/sdk/kv) — `get`/`set`/`delete`/`list`/`increment`, shared plus per-viewer (`canvasdrop.kv.user`).
- [`canvasdrop.files`](/docs/sdk/files) — `upload`/`list`/`delete`/`url`.
- [`canvasdrop.ai`](/docs/sdk/ai) — server-side model calls: `chat` and streaming `stream`.
- [`canvasdrop.realtime`](/docs/sdk/realtime) — `channel(name)` for pub/sub + presence.

## Errors

Every failure throws a typed error extending `CanvasdropError`, each carrying a
stable `.code` and `.status`. See the [error code reference](/docs/api/errors).

```js
try {
  await canvasdrop.kv.increment("votes");
} catch (err) {
  if (err.code === "CAPABILITY_DISABLED") {
    // ask the owner to enable KV in the Backend tab
  } else {
    throw err;
  }
}
```

If you import `@canvas-drop/sdk` as a module instead of the global script, the
error classes are exported for `instanceof` checks.
