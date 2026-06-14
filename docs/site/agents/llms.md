# llms.txt

If you are an agent deploying a canvas, start here. canvas-drop serves a single
plain-text contract at [`{base}/llms.txt`](/llms.txt) — no markup chrome,
designed to be dropped straight into context. It is **public** (readable without
a session) so you can learn the API before you hold credentials.

## Deploy in two steps

1. **Get a per-canvas API key** — the canvas owner creates the canvas in the
   dashboard (or `POST {base}/api/canvases`) and hands you the secret key, shown
   once.
2. **Push your artifact** with the Bearer key and a ZIP body:

   ```
   PUT {base}/v1/canvases/{id}/deploy
   Authorization: Bearer <secret-key>
   Content-Type: application/zip
   ```

   This publishes a new live version directly — no draft loop. Companion routes:
   `GET /v1/canvases/{id}`, `GET /v1/canvases/{id}/versions`,
   `POST /v1/canvases/{id}/rollback`. See the
   [Deploy API](/docs/api/deploy-api).

`{base}` is the instance origin. The key is verified per-canvas; it only
deploys to the one canvas it belongs to.

## Backend capability: the browser SDK

Inside a canvas, load the zero-config SDK — no keys in page code; identity rides
the session cookie:

```html
<script src="/sdk/v1.js"></script>
```

It exposes one global, **`canvasdrop`** (there is no `cd` alias). Mode and slug
are auto-detected from the canvas URL; every call hits
`{apiBase}/v1/c/{slug}/...` with `credentials: include`.

- `canvasdrop.me()` → `{ id, email, name, avatarUrl }`.
- `canvasdrop.kv` and `canvasdrop.kv.user` — `get`, `set`, `delete`, `list`,
  `increment`. User scope is per-viewer; root scope is shared.
- `canvasdrop.files` — `upload(file)`, `list()`, `delete(id)`, `url(id)`.
- `canvasdrop.ai` — `chat(messages, { model })` and
  `stream(messages, { model })` (SSE; server-side provider key only).
- `canvasdrop.realtime.channel(name)` — `publish`, `subscribe(handler)`,
  `presence`, `onJoin`, `onLeave`, `close`.

Full signatures and types: [SDK overview](/docs/sdk/overview).

## Capabilities and errors

A canvas must opt into **backend** (off by default); then `kv`, `files`, `ai`,
and `realtime` toggle independently. Identity (`me()`) is on whenever backend
is. A disabled feature returns `403 CAPABILITY_DISABLED`.

Errors are machine-readable: every failure carries a stable string `.code`
(e.g. `NOT_AUTHENTICATED`, `NOT_FOUND`, `CROSS_CANVAS_FORBIDDEN`,
`MODEL_NOT_ALLOWED`, `QUOTA_EXCEEDED`, `VALUE_TOO_LARGE`). Every error is a
`CanvasdropError` with a stable `.code` (some codes also have dedicated
subclasses, e.g. `NotAuthenticatedError`, `NotFoundError`,
`CapabilityDisabledError`, `QuotaExceededError`); branch on `.code`, not on
message text.

For a packaged, installable version of this guidance, see the
[Agent skill](/docs/agents/skill).
