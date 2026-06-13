# Canvas SDK (`canvasdrop`)

The browser SDK gives a canvas backend capability — key–value storage, file
storage, and the signed-in viewer's identity — with **no build step and no
secrets in the canvas**. Identity comes from the signed-in session; the canvas is
identified by its own URL.

> The canvas owner must turn on **Backend** (and the specific feature) in the
> canvas's **Capabilities** tab. A method whose capability is off throws a
> `CapabilityDisabledError`.

## Add it to a canvas

```html
<script src="/sdk/v1.js"></script>
```

That defines the global `window.canvasdrop`. The SDK auto-detects the canvas slug
and the API base from the page's location (path mode `/c/{slug}/…` or subdomain
`{slug}.{host}`), and sends every request with the session cookie.

The stable `/sdk/v1.js` path is **additive and backward-compatible within v1**, so
pointing your `<script>` at it means you receive fixes (including security
patches) without redeploying. A breaking change would ship under a new path
(`/sdk/v2.js`).

## Identity

```js
const me = await canvasdrop.me(); // { id, email, name, avatarUrl }
```

## Key–value storage

```js
// shared (canvas-global)
await canvasdrop.kv.set("votes", 0);
const n = await canvasdrop.kv.get("votes");           // value, or null if absent
const total = await canvasdrop.kv.increment("votes"); // atomic +1 (polls, counters)
await canvasdrop.kv.delete("votes");
const { entries, nextCursor } = await canvasdrop.kv.list({ prefix: "p:", limit: 100 });

// per-viewer (auto-scoped to the signed-in user)
await canvasdrop.kv.user.set("pref", "dark");
const pref = await canvasdrop.kv.user.get("pref");
```

Limits: values up to 64 KB (JSON), keys up to 512 bytes, 10,000 keys per canvas
(1,000 per user namespace). `increment` is atomic — safe for concurrent polls and
votes.

## File storage

```js
const f = await canvasdrop.files.upload(input.files[0]); // { id, name, size, url }
const all = await canvasdrop.files.list();
const href = canvasdrop.files.url(f.id); // same-origin content URL (use in <img>, <a>)
await canvasdrop.files.delete(f.id);
```

Limits: 25 MB per file, 1 GB per canvas. Downloads are served as attachments;
uploaded HTML/SVG is never rendered inline (so it can't run as another viewer).

## Errors

Every failure throws a typed error extending `CanvasdropError` (each carries a
stable `.code` and `.status`):

| Error | When |
|-------|------|
| `CapabilityDisabledError` | the feature (or Backend) is off for this canvas (403) |
| `QuotaExceededError` | value/file too large, or a quota/limit hit (409/413) |
| `NotFoundError` | the key/file doesn't exist (404) |
| `NotAuthenticatedError` | the viewer isn't signed in (401) |

With the global script, branch on `err.code` (or `err.name`):

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

(If you import `@canvas-drop/sdk` as a module instead of the global script, the
error classes are exported for `instanceof` checks.)

An agent-oriented quick reference is served at `/llms.txt`.
