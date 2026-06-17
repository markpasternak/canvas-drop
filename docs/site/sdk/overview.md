# Browser SDK

You wrote a static canvas and now you want it to remember things, store files,
greet the signed-in viewer, call a model, or sync between tabs. The browser SDK
gives your canvas those five backend capabilities — KV (key-value storage),
files, AI, identity (`me()`), and realtime — with **no build step and no secrets
in the canvas**. Identity comes from the signed-in session; the canvas is
identified by its own URL.

## Add it to a canvas

Drop in one script tag, then call the global:

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  const me = await canvasdrop.me();
  await canvasdrop.kv.set("last-viewer", me.name);
  const views = await canvasdrop.kv.increment("views");
</script>
```

(`type="module"` lets you use top-level `await`; the SDK script tag itself is a
plain `<script>` and runs first.)

The script tag defines the single global `window.canvasdrop` (that is the only
global name — there is no `cd` alias). The SDK auto-detects the canvas slug and
the API base from the page's location:

- **Path mode** — a path like `/c/{slug}/…` is matched; the slug is the segment
  after `/c/`, and the API base is the page's own origin.
- **Subdomain mode** — otherwise, the slug is the first label of the hostname
  (`{slug}.{base}`), and the API base is the page's protocol plus the remaining
  host labels (and port, if any).

Every request goes to `{apiBase}/v1/c/{slug}/…` with `credentials: "include"`, so
identity rides the existing session cookie. You never pass the slug or any key
yourself.

## Enable the capability first

The canvas owner must turn on **Backend** (and the specific feature) in the
canvas's **Backend** tab. A method whose capability is off throws a
`CapabilityDisabledError`. See [Capabilities](/docs/authoring/capabilities).

## The surface

- [`canvasdrop.me()`](/docs/sdk/identity) — the signed-in viewer (`{ id, email, name, avatarUrl, kind }`, where `kind` is `"member"` or `"guest"`).
- [`canvasdrop.kv`](/docs/sdk/kv) — `get`/`set`/`delete`/`list`/`increment`, shared plus per-viewer (`canvasdrop.kv.user`).
- [`canvasdrop.files`](/docs/sdk/files) — `upload`/`list`/`delete`/`url`.
- [`canvasdrop.ai`](/docs/sdk/ai) — server-side model calls: `chat` and streaming `stream`.
- [`canvasdrop.realtime`](/docs/sdk/realtime) — `channel(name)` for pub/sub + presence.

## Errors

Every failure throws an error extending `CanvasdropError`, which carries a string
`.code` and a numeric `.status`. Four typed subclasses are thrown directly —
`NotAuthenticatedError` (401), `NotFoundError` (404), `CapabilityDisabledError`
(403), and `QuotaExceededError` (429/409/413, the spend/rate and size-limit
failures — the `*_TOO_LARGE` codes surface here too) — and everything else surfaces as the
base `CanvasdropError`. Switch on `.code` to handle the rest. See the
[error code reference](/docs/api/errors).

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

If you import the SDK package as a module instead of using the global script, the
error classes (and `createClient`) are exported for `instanceof` checks.
