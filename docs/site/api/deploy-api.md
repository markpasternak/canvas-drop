# Deploy API

Put a canvas live over HTTP from a script, CI, or an AI agent, with no dashboard
session. Authenticate with the canvas's **secret key** as a Bearer token. A key
operates only on its own canvas, and every response has a stable, machine-readable
shape so an agent can repair and retry without a human.

```bash
# Publish a ZIP, then read back what shipped.
curl -fsS -X PUT "{base}/v1/canvases/{id}/deploy" \
  -H "Authorization: Bearer $CANVAS_KEY" \
  --data-binary @site.zip

curl -fsS "{base}/v1/canvases/{id}/files" \
  -H "Authorization: Bearer $CANVAS_KEY"
```

Base path: `{base}/v1/canvases/{id}`. `{id}` is the canvas id, not the slug.

> **Auth:** `Authorization: Bearer cd_...`, the canvas secret key. It is returned
> once, when the canvas is created (`POST /api/canvases` answers `201` with an
> `apiKey` field; the MCP `create_canvas` tool returns it too) or regenerated
> (`POST /api/canvases/{id}/regenerate-key`, MCP `regenerate_deploy_key`). Only its
> SHA-256 hash is stored, and a clone never inherits the source canvas's key. This
> path takes no cookies and no CORS; it is separate from the session-cookie auth the
> [Runtime API](/docs/api/runtime-api) and browser SDK use.

> **What is `{base}`?** The host serving the Deploy API: `CANVAS_DROP_API_BASE_URL`,
> which defaults to the instance base URL. Operators set it only when the API is
> routed on a different host than the canvases (for example canvases at
> `{slug}.canvases.example.com` and the API at `api.canvases.example.com` in
> `subdomain` mode), so do not assume it equals the dashboard host. You do not have
> to guess: over [MCP](/docs/agents/mcp), `create_canvas` (with the real key) and
> `get_canvas` (with `$CANVAS_KEY`) return the exact endpoints for the canvas,
> including a copy-paste curl command.

| Method | Path | Purpose |
|---|---|---|
| `PUT` | `/v1/canvases/{id}/deploy` | Publish a live version from a ZIP body |
| `POST` | `/v1/canvases/{id}/uploads` | Open a staged upload from a manifest |
| `PUT` | `/v1/canvases/{id}/uploads/{uploadId}/blobs/{hash}` | Stage one file's bytes |
| `POST` | `/v1/canvases/{id}/uploads/{uploadId}/finalize` | Publish from the staged upload |
| `GET` | `/v1/canvases/{id}` | Canvas metadata and publication state |
| `GET` | `/v1/canvases/{id}/versions` | List versions, newest first |
| `GET` | `/v1/canvases/{id}/files` | Read back the live version (verify a deploy) |
| `POST` | `/v1/canvases/{id}/rollback` | Make a prior ready version current |
| `POST` | `/v1/canvases/{id}/unpublish` | Take the canvas back to Draft |

**Deploy means live.** A deploy creates a new version and points the canvas at it in
one step; there is no draft to publish afterwards. If the canvas has a browser draft,
the draft is synced to the new version, or flagged stale when it holds unpublished
edits; a deploy never overwrites those edits. Deploys carry static files only: the
key cannot switch on capabilities. An owner or editor enables Backend and the
primitives the canvas needs (KV, files, AI, realtime) on the canvas's Backend tab or
with the `set_capabilities` MCP tool.

## Deploy a version

```
PUT {base}/v1/canvases/{id}/deploy
Authorization: Bearer cd_...
Content-Type: application/zip

<ZIP bytes>
```

The raw body is read as a **ZIP** regardless of `Content-Type` (a tar archive fails
with `INVALID_ZIP`). Put `index.html` at the archive root. Dotfiles and directory
entries are dropped; a path with `..` segments is rejected (`ZIP_SLIP_REJECTED`) and
an absolute path is rejected (`INVALID_PATH`); an entry that declares, or inflates
to, more than 25 MB is rejected before it can exhaust memory (`ZIP_BOMB_REJECTED`).
Writes are attributed to the canvas owner (there is no user on this path) and the
version's `source` is `"api"`.

**Success, `200`** (`DeployResult`, the same shape on every deploy path):

```json
{
  "url": "<canvas URL>",
  "version": 7,
  "fileCount": 12,
  "totalBytes": 348201,
  "warnings": ["index.html may contain a canvas API key — remove it before deploying"]
}
```

- `url`: the canvas URL (`{scheme}//{slug}.{host}/` in `subdomain` mode,
  `{base}/c/{slug}/` in `path` mode).
- `version`: the new version number; it only ever increases for a canvas.
- `fileCount` / `totalBytes`: files and bytes in the version.
- `warnings[]`: non-fatal notices. Three exist: a file will be served as
  `text/plain` because its type was downgraded; a text file looks like it embeds a
  canvas API key (keys are server-side only); the archive has no `index.html`, so
  the canvas root will 404 (a single HTML file is served at the root and is not
  flagged). Warnings never fail the deploy.

**Limits:** 100 MB per canvas, 25 MB per file, 2000 files, enforced while the archive
streams. The request body is also capped before buffering at 110 MB (canvas cap plus
10 MB of archive headroom); an over-cap body returns `413 { "code": "CANVAS_TOO_LARGE" }`.
An empty body returns `400 { "code": "EMPTY_DEPLOY" }`. Every other validation failure
on this route is a `400` with the [error shape](#errors).

**Retention:** the 10 most recent ready versions are kept per canvas; older ones are
pruned and can no longer be rolled back to.

**Rate limit:** when rate limiting is on (`CANVAS_DROP_RATELIMIT_ENABLED`, default
`true`), the deploy class throttles `PUT .../deploy`, `POST .../uploads` (begin),
`POST .../uploads/{uploadId}/finalize`, and `POST .../rollback` per canvas, keyed
after the key is verified. The default is 10 per minute
(`CANVAS_DROP_RATELIMIT_DEPLOY_PER_MIN`). Over the limit returns
`429 { "error": "rate_limited" }` with a `Retry-After` header.

## Staged upload (large or incremental)

`PUT .../deploy` sends the whole archive in one request. For large canvases, or when
you redeploy often and want to send only what changed, use the three-step staged
flow. Bytes go straight to the server (never base64'd through an agent's context),
and blobs are content-addressed, so a file the canvas already stores is not uploaded
again.

**1. Begin.** Send the full manifest: each file's canvas-relative `path`, the `hash`
(lowercase sha256 hex of its bytes), and its `size` in bytes.

```
POST {base}/v1/canvases/{id}/uploads
Authorization: Bearer cd_...
Content-Type: application/json

{ "manifest": [ { "path": "index.html", "hash": "<sha256>", "size": 1234 } ] }
```

Returns the handle and the subset of hashes the canvas does not already store:

```json
{ "uploadId": "up_...", "missingHashes": ["<sha256>", "..."] }
```

Dotfile and directory entries are skipped. A body that is not JSON, a `manifest` that
is not an array, an empty manifest, a malformed `hash` or `size`, or two entries that
share a hash but declare different sizes returns `400 INVALID_MANIFEST`. The declared
sizes are checked against the caps up front: `413 FILE_TOO_LARGE`,
`413 TOO_MANY_FILES`, or `413 CANVAS_TOO_LARGE`.

**2. Stage each missing blob.** Raw bytes; the path is irrelevant here because blobs
are addressed by `{hash}`:

```
PUT {base}/v1/canvases/{id}/uploads/{uploadId}/blobs/{hash}
Authorization: Bearer cd_...

<raw file bytes>
```

`204` on success. The bytes must hash to `{hash}` and match the size declared for it
(else `400 BLOB_HASH_MISMATCH`), the hash must appear in the begin manifest (else
`400 UPLOAD_UNEXPECTED_BLOB`), and a blob is capped at 25 MB (`413 FILE_TOO_LARGE`).
A handle that is unknown, was minted for a different canvas, or was begun by a
different actor returns `404 UPLOAD_HANDLE_INVALID` (one code, no existence leak).
Staging requests are not deploy-throttled; begin and finalize are.

**3. Finalize** to publish a version from the staged manifest:

```
POST {base}/v1/canvases/{id}/uploads/{uploadId}/finalize
Authorization: Bearer cd_...
```

Returns the same `DeployResult` as `PUT .../deploy`; the version's `source` is
`"upload"`. Finalize re-checks that the actor who began the upload is still active
and still an owner or editor of the canvas (else `404 UPLOAD_HANDLE_INVALID`). The
handle is **single-use** and lives 15 minutes from begin (then `400 UPLOAD_EXPIRED`
on stage or finalize). A finalize before every blob is staged returns
`400 UPLOAD_MISSING_BLOB` and can be retried after staging the rest; the handle is
consumed only when a version is committed, after which it returns
`409 UPLOAD_ALREADY_FINALIZED` and a fresh begin is required. Two concurrent
finalizes of one handle: the second gets `409 UPLOAD_IN_PROGRESS` while the first
holds a 60-second lease. The `warnings` on this path cover the `text/plain`
downgrade and the missing `index.html`; the API-key lint is logged on the server
rather than returned.

## Get a canvas

```
GET {base}/v1/canvases/{id}
Authorization: Bearer cd_...
```

Returns `{ id, slug, url, title, status, publicationState, currentVersionId }`. A key
resolves only an active canvas (an archived, disabled, or deleted canvas's key fails
auth with `401`), so `status` is `"active"` here and `publicationState` is
`"published"` when a live version exists, otherwise `"draft"`. To confirm a canvas is
live, check `publicationState === "published"`; you do not need to interpret
`currentVersionId` yourself.

## List versions

```
GET {base}/v1/canvases/{id}/versions
Authorization: Bearer cd_...
```

Returns `{ versions: [...] }`, newest first. Each entry is
`{ number, source, status, createdBy, createdAt, fileCount, totalBytes, current }`.
`current` marks the live version. `source` records how the version was made:
`"api"` for `PUT .../deploy`, `"upload"` for the staged flow, `"editor"` for a publish
from the browser editor, and `"zip"`, `"folder"`, or `"paste"` for dashboard deploys.
`status` is `pending` while a version is being written and `ready` once committed;
only a `ready` version can be a rollback target.

## Verify a deploy (read back the live version)

The canvas URL is access-controlled, so a keyed client cannot fetch it to check what
shipped: an unauthenticated request gets the login page. Read the live version
through the key instead.

```
GET {base}/v1/canvases/{id}/files
Authorization: Bearer cd_...
```

With no query, returns the live version's manifest, sorted by path:

```json
{ "version": 7, "fileCount": 3, "files": [
  { "path": "index.html", "size": 1280, "mime": "text/html; charset=utf-8", "hash": "9f86d0…" }
] }
```

Add `?path=` to get one file's **raw bytes**: the body is the file itself, with its
`Content-Type`, an `ETag` equal to the quoted sha256 of the content, and
`Cache-Control: no-store`. Pipe it to a checksum to confirm the bytes match what you
deployed:

```bash
curl -fsS "{base}/v1/canvases/{id}/files?path=index.html" \
  -H "Authorization: Bearer $CANVAS_KEY" | sha256sum
```

`404 NOT_PUBLISHED` when the canvas has no live version; `404 NOT_FOUND` when the
path is not in the live manifest. There is no size cap on this read: you stream the
body. (The MCP [`get_canvas_file`](/docs/agents/mcp) tool is the identity-scoped
equivalent; it inlines content up to 256 KiB and returns hash-only metadata above
that.)

## Roll back

```
POST {base}/v1/canvases/{id}/rollback
Authorization: Bearer cd_...
Content-Type: application/json

{ "version": 5 }
```

Makes a prior ready version current and returns
`200 { "url": "<canvas URL>", "version": 5 }`. `version` must be a positive integer;
a missing or invalid body returns `400 { "error": "invalid_body" }`. A number with no
ready version behind it (never existed, or pruned out of the 10-version window)
returns `404 { "code": "INVALID_PATH" }`. If the target is pruned between selection
and the pointer swap you get `409 { "code": "VERSION_UNAVAILABLE" }`: list versions
again and retry. Rollback shares the deploy-class rate limit.

## Unpublish

```
POST {base}/v1/canvases/{id}/unpublish
Authorization: Bearer cd_...
```

Takes the canvas back to **Draft**: the canvas URL goes offline and any live realtime
sockets are dropped, while the draft and the version history are kept. Publish again
with a new deploy, or by rolling back to a kept version.

**Success, `200`:** `{ "url": "<canvas URL>", "publicationState": "draft", "currentVersionId": null }`.

Unpublishing a canvas that is not currently published returns
`409 { "code": "CANNOT_UNPUBLISH" }`.

## Errors

Branch on `code` (or `error`), never on message text. Two body shapes appear on these
routes.

**Auth, body validation, and throttling** use `{ "error": "..." }`:

| Status | Body | Cause |
|---|---|---|
| `401` | `{ "error": "unauthorized" }` | Missing or unknown Bearer key, or a key whose canvas is archived, disabled, or deleted |
| `403` | `{ "error": "unauthorized" }` | The key belongs to a different canvas than `{id}` |
| `400` | `{ "error": "invalid_body" }` | Rollback body without a positive-integer `version` |
| `429` | `{ "error": "rate_limited" }` | Over the deploy-class limit for this canvas; honor `Retry-After` |

**Deploy and lifecycle failures** use a stable code plus a human message, and name
the offending file when there is one:

```json
{ "code": "<code>", "message": "...", "path": "<offending path, optional>" }
```

On `PUT .../deploy` every validation code is a `400`, except `CANVAS_TOO_LARGE`, which
is a `413` when the body is rejected before buffering:

| Code | Cause |
|---|---|
| `EMPTY_DEPLOY` | Empty body, or an archive with no deployable files |
| `INVALID_ZIP` | The body is not a readable ZIP (a tar archive lands here) |
| `ZIP_SLIP_REJECTED` | An entry path escapes the canvas root (`..` segments, or a name the ZIP reader rejects as unsafe) |
| `ZIP_BOMB_REJECTED` | An entry declares, or inflates to, more than 25 MB |
| `INVALID_PATH` | An entry path is absolute |
| `TOO_MANY_FILES` | More than 2000 files |
| `FILE_TOO_LARGE` | A file over 25 MB (inside a ZIP this surfaces as `ZIP_BOMB_REJECTED` instead) |
| `CANVAS_TOO_LARGE` | More than 100 MB in total (`413` when caught at the body cap) |

The staged-upload routes map the same shape to richer statuses:

| Code | Status | Cause |
|---|---|---|
| `INVALID_MANIFEST` | `400` | Body not JSON, `manifest` not an array or empty, bad `hash`/`size`, or one hash declared with two sizes |
| `ZIP_SLIP_REJECTED`, `INVALID_PATH` | `400` | A manifest path with `..` segments, or an absolute path |
| `FILE_TOO_LARGE`, `TOO_MANY_FILES`, `CANVAS_TOO_LARGE` | `413` | A cap exceeded: by declared size at begin, by actual bytes at stage, or by the manifest sum at finalize |
| `UPLOAD_HANDLE_INVALID` | `404` | Unknown handle, a different canvas, a different actor, or an actor no longer active or no longer owner/editor |
| `UPLOAD_EXPIRED` | `400` | More than 15 minutes since begin |
| `UPLOAD_UNEXPECTED_BLOB` | `400` | The staged hash is not in the begin manifest |
| `BLOB_HASH_MISMATCH` | `400` | The bytes do not hash to `{hash}`, or their size differs from the declared size |
| `UPLOAD_MISSING_BLOB` | `400` | Finalize before every manifest hash is staged; stage the rest and retry |
| `UPLOAD_IN_PROGRESS` | `409` | Another finalize holds the lease; retry shortly |
| `UPLOAD_ALREADY_FINALIZED` | `409` | The handle was consumed; begin again |
| `EMPTY_DEPLOY` | `400` | The manifest resolved to no deployable files |

The remaining routes use the same shape:

| Code | Status | Route and cause |
|---|---|---|
| `INVALID_PATH` | `404` | Rollback: no ready version with that number |
| `VERSION_UNAVAILABLE` | `409` | Rollback: the target was pruned during the swap; refresh and retry |
| `CANNOT_UNPUBLISH` | `409` | Unpublish: the canvas is not currently published |
| `NOT_PUBLISHED` | `404` | Read-back: no live version |
| `NOT_FOUND` | `404` | Read-back: `?path=` is not in the live manifest |

The MCP deploy tools (`deploy_canvas`, `begin_deploy`, `add_files`,
`finalize_deploy`, `rollback_canvas`, `unpublish_canvas`) wrap the same service layer
and surface the same codes; `INVALID_ENCODING` belongs to that channel only (a
`files[]` entry with an encoding other than `utf8` or `base64`) and never occurs on
these HTTP routes. Codes returned to canvases at runtime are a separate set; see
[Error codes](/docs/api/errors).
