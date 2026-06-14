---
name: canvas-drop
description: Deploy and extend small web artifacts ("canvases") on a canvas-drop instance. Use when the user wants to ship static HTML/JS to a shared URL, or give a canvas backend capability (key-value, files, identity, AI, realtime) via the zero-config browser SDK.
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
  the HTML/JS you deploy. Identity rides the signed-in session; the canvas API key
  is used only by the deploy tool, never shipped into the canvas.
- **Static only.** A canvas is plain files — no server build step. AI-generated
  HTML runs unmodified.
- **Capabilities are off until enabled.** A backend method throws
  `CapabilityDisabledError` until the canvas owner enables Backend + the feature in
  the Capabilities tab.

## Deploy a canvas

1. Obtain a per-canvas API key and the canvas id (from the dashboard, or the user).
2. Zip the site (with `index.html` at the root) and deploy:

```bash
curl -X PUT "{base}/v1/canvases/{id}/deploy" \
  -H "Authorization: Bearer $CANVAS_KEY" \
  --data-binary @site.zip
```

Other deploy-API operations: `GET {base}/v1/canvases/{id}` (state),
`GET {base}/v1/canvases/{id}/versions` (history),
`POST {base}/v1/canvases/{id}/rollback`.

## Add backend capability (browser SDK)

Add one tag — it defines the global `canvasdrop` and rides the session cookie:

```html
<script src="/sdk/v1.js"></script>
```

```js
const me = await canvasdrop.me();                 // { id, email, name, avatarUrl }
await canvasdrop.kv.increment("votes");           // atomic counter
await canvasdrop.kv.user.set("pref", "dark");     // per-viewer
const f = await canvasdrop.files.upload(file);    // { id, name, size, url }
const { text } = await canvasdrop.ai.complete(msgs, { model });
const ch = canvasdrop.realtime.channel("room");   // publish / subscribe / presence
```

## Errors

Every failure throws a typed error with a stable `.code` and `.status`. Branch on
`err.code` (e.g. `CAPABILITY_DISABLED`, `QUOTA_EXCEEDED`, `NOT_FOUND`). The full
table is at `{base}/docs/api/errors`.

## More

- Full docs: `{base}/docs`
- Agent quick reference: `{base}/llms.txt`
- See `examples/` in this skill for runnable snippets.
