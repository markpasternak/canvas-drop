# Browser SDK

You have a static canvas and want it to keep data, accept files, call a model,
know who is looking, or sync between viewers. One `<script>` tag gives the page a
global, `canvasdrop`, carrying the five primitives (KV, files, AI, identity,
realtime) plus authoring. There is no build step and nothing to configure in the
page: identity comes from the viewer's session, the canvas is identified from its
own URL, and no key ever reaches the browser.

## Add it to a canvas

One script tag, then call the global:

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  const me = await canvasdrop.me();                     // { id, email, name, avatarUrl, kind }
  await canvasdrop.kv.set("last-viewer", me.name);
  const views = await canvasdrop.kv.increment("views"); // 1 on the first call, then 2, 3, ...
</script>
```

The SDK tag is a plain `<script>`, so it runs before your module; `type="module"`
gives you top-level `await`. The root-relative `src` resolves against the
canvas's own origin, and the server serves the script there in both URL modes,
behind the same sign-in as the canvas. A fresh local instance (`pnpm dev`, `dev`
auth) is already signed in, so the snippet runs as soon as the canvas has its
backend on (see [Turn the backend on first](#turn-the-backend-on-first)).

`{base}/sdk/v1.js` is a stable path for the life of v1, cached for an hour
(`cache-control: public, max-age=3600`), so deployed canvases pick up SDK fixes
without a redeploy. On a local checkout, a `503` from that path means the bundle
is not built yet: run `pnpm build` (or `pnpm --filter @canvas-drop/sdk build`).

## One global: `canvasdrop`

The script defines exactly one global, `window.canvasdrop`. There is no `cd`
alias, no second name, and no version property on the object. The client has
`me()`, `kv`, `files`, `ai`, `realtime`, and `canvases`, and nothing else.

The same client lives in the workspace package `@canvas-drop/sdk` (private, not
published). Its module entry exports `createClient`, `detectContext`,
`SDK_VERSION` (`"1"`), `ERROR_CODES`, `errorFromResponse`, the error classes, and
the types. The served script is exactly
`createClient({ context: detectContext(window.location) })` assigned to
`window.canvasdrop`.

## How the SDK finds your canvas

`detectContext(window.location)` reads the slug and the API base from the page
URL. You never pass either yourself, and there is no override.

| URL mode | Page URL | Slug | API base |
| --- | --- | --- | --- |
| Path | `https://canvases.example.com/c/quiet-otter-x7k2/` | the segment after `/c/` | the page's own origin |
| Subdomain | `https://quiet-otter-x7k2.canvases.example.com/` | the first hostname label | the protocol plus the remaining labels (port kept, if any) |

Path mode is checked first (`/c/{slug}`); any other URL is treated as a
subdomain. Every HTTP request goes to `{apiBase}/v1/c/{slug}/…` with
`credentials: "include"`, so the viewer's session cookie rides along; realtime
opens one WebSocket per page at `{apiBase}/v1/c/{slug}/realtime` (`ws` or `wss`
to match the page). On a local path-mode instance the page is
`http://localhost:3000/c/quiet-otter-x7k2/` and the API base is
`http://localhost:3000`.

## Turn the backend on first

A canvas is static until its owner or an editor switches **Enable backend** on
in the canvas's **Backend** tab. That master switch is off by default and gates
every primitive, including `me()`. With it on, each feature has its own toggle,
and three of them also depend on an operator setting for the instance:

| Feature | Toggle in the Backend tab | Toggle default | Operator setting |
| --- | --- | --- | --- |
| Identity, `me()` | none; on whenever the backend is on | on | none |
| KV | **Key-value storage** | on | none |
| Files | **File storage** | on | none |
| AI | **AI** | on | an AI provider key (`CANVAS_DROP_AI_API_KEY`, or the admin override) |
| Realtime | **Realtime** | on | `CANVAS_DROP_REALTIME` (default `on`) |
| Authoring | **Authoring** | off | `CANVAS_DROP_AUTHORING` (default `off`), or the admin override in Admin → Configuration |

A call to anything that is off throws `CapabilityDisabledError` (code
`CAPABILITY_DISABLED`, status 403). Its `.hint` (also its `.message`) names the
gate that failed, the master switch, the feature toggle, or the operator
setting, and how to open it. Two share states close the whole API no matter how
the switches are set; both skip the owner and editors:

- **Public link**: every viewer who is not the owner or an editor, signed in or
  not, gets `STATIC_ONLY` (403) from every primitive; the owner and editors keep
  the full API.
- **Password**: on a password-protected canvas the API answers
  `PASSWORD_REQUIRED` (403) until the viewer has passed the password gate on the
  canvas page itself; the owner and editors are never prompted.

The [Capabilities](/docs/authoring/capabilities) page covers the tab.

## The surface

| Namespace | What it does | Reference |
| --- | --- | --- |
| `canvasdrop.me()` | The signed-in viewer: `{ id, email, name, avatarUrl, kind }`. `kind` is `"member"`, or `"guest"` for a retained legacy guest session. | [Identity](/docs/sdk/identity) |
| `canvasdrop.kv` | `get`, `set`, `delete`, `list`, `increment`. The same five on `canvasdrop.kv.user` store per viewer. `get` resolves `null` for a missing key. | [KV](/docs/sdk/kv) |
| `canvasdrop.files` | `upload(file)`, `list()`, `delete(id)`, and the synchronous `url(id)`. | [Files](/docs/sdk/files) |
| `canvasdrop.ai` | `chat(messages, { model })` resolves `{ text, usage, cost }`; `stream(messages, { model })` yields text chunks. `model` is required; `system` and `maxTokens` are optional. | [AI](/docs/sdk/ai) |
| `canvasdrop.realtime` | `channel(name)` returns a channel with `publish`, `subscribe`, `unsubscribe`, `presence`, `onPresence`, `onJoin`, `onLeave`, `close`, over one shared WebSocket that reconnects on its own. | [Realtime](/docs/sdk/realtime) |
| `canvasdrop.canvases` | `publish`, `update`, `list`, `revoke`: a signed-in viewer creates and manages canvases from the page, as themselves (the authoring capability). | [Authoring](/docs/sdk/authoring) |

## Errors

Every failure throws an error extending `CanvasdropError`: a string `.code`, a
numeric `.status`, and, when the server sent one, a `.hint` with the fix. Six
subclasses cover the cases you most often branch on:

| Class | `.code` | `.status` |
| --- | --- | --- |
| `NotAuthenticatedError` | `NOT_AUTHENTICATED` | 401 |
| `NotFoundError` | `NOT_FOUND` | 404 |
| `CapabilityDisabledError` | `CAPABILITY_DISABLED` | 403 |
| `QuotaExceededError` | `QUOTA_EXCEEDED`, `GUEST_AI_CAP`, `KEY_LIMIT`, `CONNECTION_LIMIT`, or a size code (`KEY_TOO_LARGE`, `VALUE_TOO_LARGE`, `FILE_TOO_LARGE`) | 429, 409, or 413 (the wire status) |
| `PublishFailedError` | `PUBLISH_FAILED`, with the new canvas's `.id` | 502 |
| `UpdatePartialError` | `UPDATE_PARTIAL`, with `.stage` and the saved `.current` record | 502 |

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

Three cases do not throw the way the rest do:

- `kv.get` on a missing key resolves `null` rather than throwing `NotFoundError`.
- Realtime reports sign-in, capability, and connection-limit failures by closing
  the socket; the next `publish` or `presence()` call on any channel throws that
  error. A `presence()` call still in flight when the connection drops rejects
  with `DISCONNECTED` (status 0); retry it once the socket is back. A channel
  you have `close()`d throws `CHANNEL_CLOSED` (status 0).
- With the module import, the error classes are exported for `instanceof`
  checks; with the global script, branch on `.code` or `.name`.
