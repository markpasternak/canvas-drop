# Create & deploy

There are four ways to get a canvas live. All produce the same thing: a versioned
set of static files served at the canvas URL.

## Drag-and-drop a folder or ZIP

The fastest path for an existing project. Drop a folder (or a `.zip`) that
contains an `index.html` at its root. The files are uploaded, a version is
created, and the canvas goes live.

## Paste HTML

For a one-file canvas, paste HTML directly. canvas-drop wraps it into an
`index.html` and deploys it.

## In-browser editor

Create files and edit them with syntax highlighting in the browser. Your work is
saved as a **draft**; you choose when to **publish** a version. See
[The editor](/docs/authoring/editor).

## Deploy API

Ship from CI or an agent with a per-canvas API key over HTTP — no human and no
dashboard session required:

```bash
curl -X PUT "{base}/v1/canvases/{id}/deploy" \
  -H "Authorization: Bearer $CANVAS_KEY" \
  --data-binary @site.zip
```

See the [Deploy API reference](/docs/api/deploy-api).

## Versions and rollback

Every deploy creates a new version. The canvas always serves its currently
published version, and you can roll back to a previous one from the dashboard or
the API. Versions are content-addressed, so re-deploying identical files is cheap.
