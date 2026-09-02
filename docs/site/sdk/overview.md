# Browser SDK

Add KV storage, file storage, AI, the signed-in viewer's identity, and realtime
sync to a static canvas through one global, `canvasdrop`. There is no build step
and nothing to configure in the page: identity comes from the viewer's session,
the canvas is identified from its own URL, and no key ever reaches the browser.

## Add it to a canvas

One script tag, then call the global:

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  const me = await canvasdrop.me();
  await canvasdrop.kv.set("last-viewer", me.name);
  const views = await canvasdrop.kv.increment("views");
</script>
```

The SDK tag is a plain `<script>`, so it runs before your module; `type="module"`
gives you top-level `await`. The root-relative `src` resolves against the
canvas's own origin, where the server serves the script in both URL modes,
behind the same sign-in as the canvas. A fresh local instance (`pnpm dev`, `dev`
auth) is already signed in, so the snippet runs as soon as the canvas has
**Backend** switched on (see [Turn the backend on first](#turn-the-backend-on-first)).

`{base}/sdk/v1.js` is a stable path for the life of v1, cached for an hour
(`cache-control: public, max-age=3600`), so deployed canvases pick up SDK fixes
without a redeploy.

## One global: `canvasdrop`

The script defines exactly one global, `window.canvasdrop`. There is no `cd`
alias, no second name, and no version property on the object.

If you import the `@canvas-drop/sdk` package as a module instead, it exports
`createClient`, `detectContext`, `SDK_VERSION`, `ERROR_CODES`,
`errorFromResponse`, and the error classes. The served script is that same
client with the context detected for you.

## How the SDK finds your canvas

`detectContext(window.location)` reads the slug and the API base from the page
URL. You never pass either yourself.

| URL mode | Page URL | Slug | API base |
| --- | --- | --- | --- |
| Path | `https://canvases.example.com/c/quiet-otter-x7k2/` | the segment after `/c/` | the page's own origin |
| Subdomain | `https://quiet-otter-x7k2.canvases.example.com/` | the first hostname label | the protocol plus the remaining labels (port kept, if any) |

Path mode is checked first (`/c/{slug}`); any other URL is treated as a
subdomain. Every request goes to `{apiBase}/v1/c/{slug}/…` with
`credentials: "include"`, so the viewer's session cookie rides along. On a
local path-mode instance that is `http://localhost:3000/v1/c/quiet-otter-x7k2/…`.

## Turn the backend on first

A canvas is static until its owner or an editor turns on **Backend** in the
canvas's **Backend** tab. That master switch is off by default and gates every
primitive, including `me()`. With it on:

- **Identity** has no toggle of its own; `me()` works whenever the backend is on.
- **KV**, **files**, **AI**, and **realtime** each have their own toggle, on by
  default. AI also needs a provider key configured by the operator; realtime
  also needs the operator to have enabled it for the instance.
- **Authoring** is off by default and stays off until the owner enables it and
  the operator has opted the instance in.

A call to anything that is off throws `CapabilityDisabledError` (code
`CAPABILITY_DISABLED`, status 403); its `.hint` names the gate that failed and
how to open it. On a canvas shared as a public link, public visitors get
`STATIC_ONLY` (403) from every primitive even with Backend on. The
[Capabilities](/docs/authoring/capabilities) page covers the tab.

## The surface

| Namespace | What it does | Reference |
| --- | --- | --- |
| `canvasdrop.me()` | The signed-in viewer: `{ id, email, name, avatarUrl, kind }`. `kind` is `"member"`, or `"guest"` for a retained legacy guest session. | [Identity](/docs/sdk/identity) |
| `canvasdrop.kv` | `get`, `set`, `delete`, `list`, `increment`. The same five on `canvasdrop.kv.user` store per viewer. `get` resolves `null` for a missing key. | [KV](/docs/sdk/kv) |
| `canvasdrop.files` | `upload(file)`, `list()`, `delete(id)`, and the synchronous `url(id)`. | [Files](/docs/sdk/files) |
| `canvasdrop.ai` | `chat(messages, { model })` resolves the full text with usage and cost; `stream(messages, { model })` yields text chunks. `model` is required. | [AI](/docs/sdk/ai) |
| `canvasdrop.realtime` | `channel(name)` returns a channel with `publish`, `subscribe`, `unsubscribe`, `presence`, `onPresence`, `onJoin`, `onLeave`, `close`, over one shared WebSocket that reconnects on its own. | [Realtime](/docs/sdk/realtime) |
| `canvasdrop.canvases` | `publish`, `update`, `list`, `revoke`: a signed-in viewer creates and manages canvases from the page, as themselves (the authoring capability). | [Authoring](/docs/sdk/authoring) |

## Errors

Every failure throws an error extending `CanvasdropError`: a string `.code`, a
numeric `.status`, and, when the server sent one, a `.hint` with the fix. Five
subclasses cover the cases you most often branch on:

| Class | `.code` | `.status` |
| --- | --- | --- |
| `NotAuthenticatedError` | `NOT_AUTHENTICATED` | 401 |
| `NotFoundError` | `NOT_FOUND` | 404 |
| `CapabilityDisabledError` | `CAPABILITY_DISABLED` | 403 |
| `QuotaExceededError` | `QUOTA_EXCEEDED`, `GUEST_AI_CAP`, `KEY_LIMIT`, `CONNECTION_LIMIT`, or a size code (`KEY_TOO_LARGE`, `VALUE_TOO_LARGE`, `FILE_TOO_LARGE`) | 429, 409, or 413 |
| `PublishFailedError` | `PUBLISH_FAILED`, with the new canvas's `.id` | 502 |

Everything else (`PASSWORD_REQUIRED`, `STATIC_ONLY`, `DISABLED`,
`MODEL_NOT_ALLOWED`, `NOT_NUMERIC`, `INVALID_BODY`, and the rest) arrives as the
base `CanvasdropError`; branch on `.code`. The full list is on the
[error codes](/docs/api/errors) page.

```js
try {
  await canvasdrop.kv.increment("votes");
} catch (err) {
  if (err.code === "CAPABILITY_DISABLED") {
    // ask the owner to enable KV in the Backend tab; err.hint says what is off
  } else {
    throw err;
  }
}
```

Two cases do not throw the way the rest do: `kv.get` on a missing key resolves
`null` rather than throwing `NotFoundError`, and realtime reports sign-in,
capability, and connection-limit failures by closing the socket, after which the
next `publish` or `presence()` call throws that error. With the module import,
the error classes are exported for `instanceof` checks; with the global script,
branch on `.code` or `.name`.
