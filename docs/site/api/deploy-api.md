# Deploy API

The deploy API ships canvases over HTTP — from CI, a script, or an AI agent — with
**no dashboard session**. It authenticates with a per-canvas **API key** (a Bearer
token), and a key operates only on its own canvas.

> **Auth:** `Authorization: Bearer <canvas-key>`. This is distinct from the
> session-cookie auth the [Runtime API](/docs/api/runtime-api) and the browser SDK
> use. The deploy API is mounted ahead of the session gateway so agents need no
> org login.

Base path: `{base}/v1/canvases`.

## Deploy a version

```
PUT {base}/v1/canvases/{id}/deploy
Authorization: Bearer <canvas-key>
Content-Type: application/zip
<zip body>
```

Uploads a ZIP (with `index.html` at its root), creates a new version, and points
the canvas at it. Returns the new version metadata. Oversized bodies are rejected.

```bash
curl -X PUT "{base}/v1/canvases/{id}/deploy" \
  -H "Authorization: Bearer $CANVAS_KEY" \
  --data-binary @site.zip
```

## Get a canvas

```
GET {base}/v1/canvases/{id}
Authorization: Bearer <canvas-key>
```

Returns the canvas's current state (slug, current version, status).

## List versions

```
GET {base}/v1/canvases/{id}/versions
Authorization: Bearer <canvas-key>
```

Returns the version history, newest first.

## Roll back

```
POST {base}/v1/canvases/{id}/rollback
Authorization: Bearer <canvas-key>
```

Points the canvas back at a previous version.

## Errors

Failures return a stable machine-readable `code` (see [Error codes](/docs/api/errors)).
A key used against a canvas it does not own gets `NOT_FOUND` (no existence leak).
