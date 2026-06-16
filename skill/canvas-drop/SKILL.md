---
name: canvas-drop
description: Deploy and extend small web artifacts ("canvases") on a canvas-drop instance. Use when the user wants to ship static HTML/JS to a shared URL, or give a canvas backend capability (key-value, files, identity, AI, realtime) via the zero-config browser SDK. Connect over MCP for an identity-scoped, multi-tool surface, or deploy over HTTP with a per-canvas key.
---

# canvas-drop

canvas-drop hosts small static web artifacts ("canvases") at shared URLs and gives
them backend capability through a zero-config browser SDK. You can deploy a canvas
over HTTP with a per-canvas API key — no human and no dashboard session required.

Replace `{base}` below with the instance's base URL (ask the user if unknown).

## When to use this skill

- The user wants to publish an HTML/JS prototype, dashboard, demo, or small tool
  to a URL their colleagues can open.
- The user wants a canvas to persist data, store files, read the signed-in viewer,
  call an AI model, or sync in realtime — without managing a backend.

## Golden rules

- **Never put a secret in canvas files.** No API keys, provider keys, or tokens in
  the HTML/JS you deploy. Identity rides the signed-in session cookie; the per-canvas
  API key is used only by the deploy tool, never shipped into the canvas.
- **Static only.** A canvas is plain files — no server build step. AI-generated
  HTML runs unmodified.
- **Capabilities are off until enabled.** A backend method throws
  `CapabilityDisabledError` (`.code` `CAPABILITY_DISABLED`, 403) until the canvas
  owner enables the **Backend** master switch plus the feature in the **Backend** tab.
  Identity (`me()`) has no separate toggle — it is on whenever Backend is on.

## Two ways to act on canvases

- **Connect over MCP (recommended when your client supports it).** One connect, no
  key to paste — you get identity-scoped tools across all the canvases you own.
- **Deploy over HTTP with a per-canvas key (below).** No session needed; best for a
  keyed, sessionless agent or a CI step that was handed one canvas's key.

## Connect over MCP

If your agent host speaks MCP (Claude, ChatGPT, …), add the instance's MCP endpoint:

```
{base}/mcp
```

The client walks an OAuth sign-in once (your normal org login + a consent screen) —
**no secret to copy**. Once connected you have these tools, each scoped to your
account and the canvases you own:

- `whoami` — the connected account.
- `create_canvas` — make a canvas; returns its id, URL, and a one-time deploy key.
- `list_canvases` — the canvases you own.
- `get_canvas` / `list_versions` — current state and version history.
- `deploy_canvas` — publish static files (a base64 ZIP) directly to live.
- `rollback_canvas` — point the canvas back at an earlier version number.
- `unpublish_canvas` — take a published canvas back to draft.

A tool only ever acts on canvases you own; a canvas you don't own reads as not found.
Typical flow: `create_canvas` → `deploy_canvas` with your files, all in one session.

See [`{base}/docs/agents/mcp`]({base}/docs/agents/mcp) for the full reference.

## Deploy a canvas (HTTP)

The deploy API publishes a version directly to live (no draft loop). You need the
canvas `id` and its per-canvas secret key, both from the dashboard create flow (the
key is shown once at creation; an owner can regenerate it).

Send a ZIP archive (with `index.html` at the root) as the request body:

```bash
curl -X PUT "{base}/v1/canvases/{id}/deploy" \
  -H "Authorization: Bearer $CANVAS_KEY" \
  --data-binary @site.zip
```

The key is verified per-canvas. Companion deploy-API operations (same Bearer auth):

- `GET {base}/v1/canvases/{id}` — current state
- `GET {base}/v1/canvases/{id}/versions` — version history (last 10 kept)
- `POST {base}/v1/canvases/{id}/rollback` with JSON body `{"version": N}` — sets the
  live pointer to ready version N (find N via the `/versions` list, where each entry
  has a `number`). A missing/non-number `version` returns `400 INVALID_PATH`; an
  unknown or non-ready version returns `404 INVALID_PATH`; a version removed by a
  concurrent prune returns `409 VERSION_UNAVAILABLE` (retry).

A deploy-API key only works while the canvas is active; if the canvas is archived or
disabled, the key is not recognized and the request returns 401 unauthorized. (The 409
`NOT_ACTIVE` code is dashboard-only; a disabled canvas surfaces as `DISABLED` (403) on
the runtime API.)

## Add backend capability (browser SDK)

Add one tag — it defines the global `canvasdrop` (no `cd` alias) and rides the
session cookie. The bundle and slug/origin are auto-detected from the page location,
so the same file works in both path and subdomain URL modes:

```html
<script src="/sdk/v1.js"></script>
```

```js
// Identity — { id, email, name, avatarUrl, kind }; kind is "member" or "guest"
const me = await canvasdrop.me();

// KV (shared scope) + kv.user (per-viewer scope) — same five methods on each
await canvasdrop.kv.set("config", { theme: "dark" });
const cfg = await canvasdrop.kv.get("config");        // null if absent
const n = await canvasdrop.kv.increment("votes");     // atomic; returns new number
const page = await canvasdrop.kv.list({ prefix: "c", limit: 50 });
await canvasdrop.kv.user.set("pref", "dark");         // scoped to the viewer

// Files — upload returns { id, name, size, url }
const f = await canvasdrop.files.upload(fileObject);
const files = await canvasdrop.files.list();
const src = canvasdrop.files.url(f.id);               // synchronous absolute URL

// AI — model is required; returns { text, usage, cost }
const { text } = await canvasdrop.ai.chat(
  [{ role: "user", content: "Summarize this." }],
  { model: "claude-...", system: "Be terse.", maxTokens: 512 },
);
for await (const delta of canvasdrop.ai.stream(messages, { model })) {
  // delta is a text chunk
}

// Realtime — one channel object per name
const ch = canvasdrop.realtime.channel("room");
ch.subscribe((msg) => { /* { event, data, from } */ });
ch.publish("move", { x: 1 });
ch.onJoin((user) => {});                              // also onLeave, onPresence
const users = await ch.presence();                   // [{ id, name }]
```

Notes on signatures (these differ from older docs):

- AI is `chat(messages, options)` / `stream(messages, options)` — there is **no**
  `complete()`. `AiMessage.role` is `"user"` or `"assistant"` only; the system
  prompt goes in `options.system`.
- `realtime.channel().subscribe(handler)` takes the message handler. Listeners are
  the specific `subscribe` / `onPresence` / `onJoin` / `onLeave` — there is no
  generic `on(event, handler)`.
- All SDK requests go to `{apiBase}/v1/c/{slug}/...` with `credentials: "include"`.

## Errors

Every failure throws a `CanvasdropError` with a stable `.code` string and `.status`
number. Branch on `err.code`. Common codes:

| `.code` | status | when |
|---|---|---|
| `NOT_AUTHENTICATED` | 401 | viewer not signed in |
| `CAPABILITY_DISABLED` | 403 | Backend or the feature is off for this canvas |
| `MODEL_NOT_ALLOWED` | 403 | AI model not in the instance allow-list |
| `NOT_FOUND` | 404 | key, file, or canvas does not exist |
| `INVALID_BODY` | 400 | request body failed validation |
| `VALUE_TOO_LARGE` / `KEY_TOO_LARGE` | 413 | KV value / KV key over limit |
| `FILE_TOO_LARGE` | 413 | uploaded file over the per-file size limit |
| `KEY_LIMIT` | 409 | canvas hit its key-count limit |
| `NOT_NUMERIC` | 409 | `increment` on a non-numeric value |
| `QUOTA_EXCEEDED` | 429 | spend or rate quota exceeded |
| `CONNECTION_LIMIT` | 429 | too many concurrent realtime connections |
| `AI_STREAM_TRUNCATED` / `AI_UPSTREAM_ERROR` | 502 | AI stream ended early / provider error |
| `REQUEST_FAILED` | 0 | request failed with no specific code |

Typed subclasses with `instanceof` support: `CapabilityDisabledError`,
`QuotaExceededError`, `NotFoundError`, `NotAuthenticatedError`. Note that any 409 or
413 response maps to `QuotaExceededError` — so `KEY_LIMIT`, `NOT_NUMERIC` (409), and
`VALUE_TOO_LARGE` / `KEY_TOO_LARGE` / `FILE_TOO_LARGE` (413) are surfaced as `QuotaExceededError` (with
the wire `.code` intact). Only codes outside the typed-subclass mapping fall through to
the base `CanvasdropError` carrying the wire `.code`.

## More

- Full docs: `{base}/docs`
- Agent quick reference: `{base}/llms.txt`
- See `examples/` in this skill for runnable snippets.
