# Create & publish

You have files (or HTML, or a build directory) and want a live, shareable URL.
This page covers the four ways to get there and how publishing works.

A canvas serves an **immutable, versioned set of static files** at its canvas URL.
Three deploy paths publish a version directly — drag a folder/files, upload a ZIP,
or paste HTML — plus a programmatic **Deploy API** for CI and agents. The fourth
source, the in-browser [editor](/docs/authoring/editor), saves a draft first and
lets you publish when you're ready.

All four start from the create flow at `/new` (which also mints the canvas), and
the first three are also available on an existing canvas to publish its next
version.

## Drag-and-drop files or a folder

The fastest path for an existing project. From the create flow, drop individual
files or a whole folder. Relative paths are preserved at the canvas root, so an
`index.html` at the folder root is served at the canvas URL. The files upload, a
version is created, and the canvas is published in one step.

## Upload a ZIP

Upload a `.zip` and the server extracts it. Extraction is path-safe (zip-slip and
zip-bomb archives are rejected). As with a folder, an `index.html` at the archive
root is the entry point.

## Paste HTML

For a one-file canvas, paste HTML directly. canvas-drop wraps it into a single
`index.html` and publishes it. From the create flow this both creates the canvas
and publishes it; on an existing canvas, pasting publishes the next version.

## In-browser editor

Create and edit files with syntax highlighting in the browser. Your work is saved
as a **draft** as you type; you choose when to **publish** a version. This is the
only source that uses the draft/publish loop — the other three publish a version
directly. See [The editor](/docs/authoring/editor).

## Custom slug

The canvas URL ends in a **slug**. By default a new canvas gets a readable random
slug; you can choose your own at create time (the slug field in `/new`) or change
it later from the canvas **Settings** tab → URL & routing. Slugs are DNS-safe and
reserved words are rejected; if the one you want is taken you'll get
`409 slug_taken`. Changing a slug takes effect on the next request and the old
URL stops resolving.

A custom slug is guessable, so for any link-reachable canvas rely on the access
rung, not on the URL being secret. See [Sharing & access](/docs/authoring/sharing).

## Deploy API

Ship from CI or an agent with a per-canvas secret key over HTTP — no human and no
dashboard session required. The body is a ZIP archive; the response is
machine-readable. This path publishes a version **directly to live** (no draft
loop). "Deploy" is the API term for this publish-from-files contract:

```bash
curl -X PUT "{base}/v1/canvases/{id}/deploy" \
  -H "Authorization: Bearer cd_..." \
  --data-binary @site.zip
```

Create a canvas wired for this path from the **API** method in the create flow
(`/new`): it mints the canvas and a one-time secret key. The key (format `cd_...`)
is shown once and can be regenerated later from the **Settings** tab (Deploy API
section). It is a Bearer secret, not a session cookie, and works **only on its
own canvas** (a key for a different canvas returns `403`; an unknown or missing
key returns `401`).

On success you get the new version's details:

```json
{ "url": "...", "version": 7, "fileCount": 12, "totalBytes": 48213, "warnings": [] }
```

On a validation failure you get a stable error code, so an agent can repair and
retry:

```json
{ "code": "ZIP_SLIP_REJECTED", "message": "...", "path": "../evil" }
```

A single-shot `PUT .../deploy` returns `400` for every validation error. Codes you
may see: `EMPTY_DEPLOY`, `TOO_MANY_FILES`, `FILE_TOO_LARGE`, `CANVAS_TOO_LARGE`,
`ZIP_SLIP_REJECTED`, `ZIP_BOMB_REJECTED`, `INVALID_ZIP`, `INVALID_PATH`. Limits:
100 MB/canvas, 25 MB/file, 2000 files (a body over the limit is rejected with
`413` before parsing). The endpoint is rate-limited to 10 deploys/min/canvas
(`429 rate_limited` with `Retry-After`). `warnings[]` carries non-fatal notices —
e.g. a file that may contain a canvas API key you should remove before publishing,
or a path that will be served as `text/plain`.

For large or repeat deploys, the **staged upload** flow sends only changed files:
`POST .../uploads` with a manifest of `{path, hash, size}` returns the hashes not
yet stored, you `PUT` each missing blob, then `POST .../uploads/:uploadId/finalize`
publishes the version. The Deploy API also exposes `GET /v1/canvases/:id`
(metadata), `GET .../versions`, `GET .../files` (read-back, `?path=` returns raw
bytes), `POST .../unpublish`, and `POST .../rollback` (body `{ version }`). See the
[Deploy API reference](/docs/api/deploy-api).

## Versions and rollback

Every publish creates a new immutable version; the canvas always serves its
**current** version. Roll back to an earlier version from the dashboard (the
**Versions** tab → **Make current**) or the API (`POST /v1/canvases/:id/rollback`).
Files are content-addressed — only changed files are stored and re-publishing
identical files is cheap. The last 10 versions are kept.
