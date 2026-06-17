# Deploy API

Ship a canvas over HTTP — from CI, a script, or an AI agent — with **no dashboard
session**. Authenticate with the canvas's **secret key** as a Bearer token. A key
operates only on its own canvas, and every response is machine-readable so an agent
can repair and retry without a human.

```bash
# Deploy a ZIP and confirm it's live, end to end.
curl -fsS -X PUT "{base}/v1/canvases/{id}/deploy" \
  -H "Authorization: Bearer $CANVAS_KEY" \
  --data-binary @site.zip
```

> **Auth:** `Authorization: Bearer cd_...` — the canvas secret key, not a session
> cookie. It is shown once at creation and stored hashed (SHA-256). This path takes
> no cookies and no CORS, and is distinct from the session-cookie auth the
> [Runtime API](/docs/api/runtime-api) and browser SDK use.

Base path: `{base}/v1/canvases/{id}`. `{id}` is the canvas id (not the slug).

> **What is `{base}`?** The host serving this API — `CANVAS_DROP_API_BASE_URL`, which
> defaults to the instance base URL. In `subdomain` mode the API is usually fronted on
> its own host (e.g. `https://api.example.com`), separate from the canvas hosts
> (`{slug}.example.com`) — so don't assume it equals the dashboard host. You don't have
> to guess it: `create_canvas` (over [MCP](/docs/agents/mcp)) returns the exact,
> ready-to-run curl endpoints for the canvas, and the create flow shows them too.

| Method | Path | Purpose |
|---|---|---|
| `PUT` | `/v1/canvases/{id}/deploy` | Publish a live version from an archive body |
| `POST` | `/v1/canvases/{id}/uploads` | Open a staged upload from a manifest |
| `PUT` | `/v1/canvases/{id}/uploads/{uploadId}/blobs/{hash}` | Stage one file's bytes |
| `POST` | `/v1/canvases/{id}/uploads/{uploadId}/finalize` | Publish from the staged upload |
| `GET` | `/v1/canvases/{id}` | Canvas metadata |
| `GET` | `/v1/canvases/{id}/versions` | List versions |
| `GET` | `/v1/canvases/{id}/files` | Read back the live version (verify a deploy) |
| `POST` | `/v1/canvases/{id}/rollback` | Restore a prior ready version |
| `POST` | `/v1/canvases/{id}/unpublish` | Take the canvas back to Draft |

## Deploy a version

```
PUT {base}/v1/canvases/{id}/deploy
Authorization: Bearer cd_...
Content-Type: application/zip
<archive body>
```

The raw request body is ingested as a **ZIP** archive (put `index.html` at its
root); the body is always read with the ZIP reader regardless of `Content-Type`. A new version is created and the canvas points at it. Deploys via this key
are attributed to the canvas owner and audited as `source: "api"`.

```bash
# Ships static files only. To use the browser SDK, first enable Backend +
# the capabilities you need (kv, files, ai, realtime) in the canvas's Backend tab —
# the deploy key can't toggle them.
curl -X PUT "{base}/v1/canvases/{id}/deploy" \
  -H "Authorization: Bearer $CANVAS_KEY" \
  --data-binary @site.zip
```

**Success — `200`** (`DeployResult`, stable shape):

```json
{
  "url": "<canvas public URL>",
  "version": 7,
  "fileCount": 12,
  "totalBytes": 348201,
  "warnings": ["index.html may contain a canvas API key — remove it before deploying"]
}
```

- `url` — the canvas's public URL.
- `version` — the new version number.
- `fileCount` / `totalBytes` — files and bytes written.
- `warnings[]` — non-fatal notices (e.g. a file MIME-downgraded to `text/plain`, or
  the deploy-time key-lint flagging a file that may embed a canvas API key). Warnings
  do not fail the deploy.

**Limits:** 100 MB/canvas, 25 MB/file, 2000 files. The body is also capped before
buffering at 110 MB (canvas cap + 10 MB); an over-limit body returns
`413 { "code": "CANVAS_TOO_LARGE" }`. An empty body returns
`400 { "code": "EMPTY_DEPLOY" }`.

**Rate limit:** when rate limiting is enabled, the deploy-class endpoints —
`PUT .../deploy`, `POST .../uploads` (begin), `POST .../uploads/{uploadId}/finalize`,
and `POST .../rollback` — are throttled per canvas (keyed after the key is verified).
The default is 10/min (`CANVAS_DROP_RATELIMIT_DEPLOY_PER_MIN`). Over-limit returns
`429 { "error": "rate_limited" }` with a `Retry-After` header.

## Staged upload (large or incremental)

`PUT .../deploy` sends the whole archive in one request. For large canvases — or
when you re-deploy often and want to send only what changed — use the three-step
staged flow. Bytes go straight to the server (never base64'd through an agent's
context), and content-addressing means an unchanged file is never re-uploaded.

**1 — begin.** Send the full manifest: each file's `path`, `hash` (sha256 hex of
its bytes), and `size`.

```
POST {base}/v1/canvases/{id}/uploads
Authorization: Bearer cd_...
Content-Type: application/json

{ "manifest": [ { "path": "index.html", "hash": "<sha256>", "size": 1234 } ] }
```

Returns the handle and the subset of hashes the server doesn't already have:

```json
{ "uploadId": "up_...", "missingHashes": ["<sha256>", "..."] }
```

**2 — stage each missing blob** (raw bytes; the path is irrelevant here — blobs are
content-addressed by `{hash}`):

```
PUT {base}/v1/canvases/{id}/uploads/{uploadId}/blobs/{hash}
Authorization: Bearer cd_...
<raw file bytes>
```

`204` on success. The bytes must hash to `{hash}` (else `400 BLOB_HASH_MISMATCH`),
the blob is capped at 25 MB (`413 FILE_TOO_LARGE`), and a handle minted for a
different canvas is rejected `404 UPLOAD_HANDLE_INVALID` (no existence leak).

**3 — finalize** to publish a version from the staged manifest:

```
POST {base}/v1/canvases/{id}/uploads/{uploadId}/finalize
Authorization: Bearer cd_...
```

Returns the same `DeployResult` shape as `PUT .../deploy`. The handle is
**single-use** and short-lived (15 min, then `400 UPLOAD_EXPIRED`). A finalize
before every blob is staged returns `400 UPLOAD_MISSING_BLOB` and can be retried
after staging the rest — the handle is consumed only on a successful publish.
Attributed to the owner, audited as `source: "upload"`.

> **Availability:** the staged-upload routes exist only when the instance has the
> upload service wired. Where it isn't, the three `…/uploads…` endpoints return
> `404` — fall back to `PUT .../deploy` with the whole archive.

## Get a canvas

```
GET {base}/v1/canvases/{id}
Authorization: Bearer cd_...
```

Returns `{ id, slug, url, title, status, publicationState, currentVersionId }`, so
an agent can confirm a canvas is live without interpreting `status` +
`currentVersionId` itself.

## List versions

```
GET {base}/v1/canvases/{id}/versions
Authorization: Bearer cd_...
```

Returns the canvas's versions, newest first.

## Verify a deploy (read back the live version)

The canvas's public URL is **access-controlled** — a keyed/curl agent can't fetch it to
check what shipped (an unauthenticated request gets a login page). Use this instead. The
key only works on its own canvas, so it's an owner-scoped read.

```
GET {base}/v1/canvases/{id}/files
Authorization: Bearer cd_...
```

With no query, returns the live version's manifest:

```json
{ "version": 7, "fileCount": 3, "files": [
  { "path": "index.html", "size": 1280, "mime": "text/html; charset=utf-8", "hash": "9f86d0…" }
] }
```

Add `?path=` to get one file's **raw bytes** (the body is the file itself, with its
`Content-Type` and an `ETag` of the content hash) — pipe it straight to a checksum to
confirm the bytes match what you deployed:

```bash
curl -fsS "{base}/v1/canvases/{id}/files?path=index.html" \
  -H "Authorization: Bearer $CANVAS_KEY" | sha256sum
```

`404 NOT_PUBLISHED` if the canvas has no live version; `404 NOT_FOUND` if the path isn't
in the live manifest. (The MCP [`get_canvas_file`](/docs/agents/mcp) tool is the
identity-scoped equivalent; it inlines content up to 256 KiB and returns hash-only
metadata above that — this HTTP read-back has no size cap since you stream the body.)

## Roll back

```
POST {base}/v1/canvases/{id}/rollback
Authorization: Bearer cd_...
Content-Type: application/json

{ "version": 5 }
```

Restores a prior ready version and points the canvas back at it; returns
`200 { "url": "<canvas URL>", "version": 5 }`. Rollback shares the deploy-class
rate limit. A target version that doesn't exist or
isn't ready returns `404 { "code": "INVALID_PATH" }`; a missing or non-numeric
`version` field returns `400 { "code": "INVALID_PATH" }`; and if the target was
pruned between selection and the swap you get `409 { "code": "VERSION_UNAVAILABLE" }`
(refresh and retry). See [Errors](#errors).

## Unpublish

```
POST {base}/v1/canvases/{id}/unpublish
Authorization: Bearer cd_...
```

Takes the canvas back to **Draft**: the public URL goes offline and any live
realtime sockets are dropped, while the draft and version history are kept.
Re-publish later with `PUT .../deploy` or by rolling back to a kept version.

**Success — `200`:** `{ "url": "<canvas URL>", "publicationState": "draft", "currentVersionId": null }`.

Unpublishing a canvas that isn't currently published returns
`409 { "code": "CANNOT_UNPUBLISH" }`.

## Errors

Validation failures return a stable `code` so agents can repair from the body.
`DeployError` validation failures on **deploy** are **`400`**:

```json
{ "code": "<DeployErrorCode>", "message": "...", "path": "<offending path, optional>" }
```

Codes: `EMPTY_DEPLOY`, `TOO_MANY_FILES`, `FILE_TOO_LARGE`, `CANVAS_TOO_LARGE`,
`ZIP_SLIP_REJECTED`, `ZIP_BOMB_REJECTED`, `INVALID_ZIP`, `INVALID_PATH`,
`PATH_EXISTS`, `VERSION_UNAVAILABLE`, `CANNOT_UNPUBLISH`. See
[Error codes](/docs/api/errors) for the full table.

The staged-upload routes use a richer status mapping than the blanket `400`:
`INVALID_MANIFEST` (`400`), `UPLOAD_HANDLE_INVALID` (`404` — unknown / wrong-owner /
wrong-canvas handle, no existence leak), `UPLOAD_EXPIRED` (`400`),
`UPLOAD_ALREADY_FINALIZED` / `UPLOAD_IN_PROGRESS` (`409`), `UPLOAD_MISSING_BLOB`
(`400`), `BLOB_HASH_MISMATCH` (`400`), `INVALID_ENCODING` (`400`). On these routes
the size caps surface as `413`, not `400`: `CANVAS_TOO_LARGE`, `TOO_MANY_FILES`,
`FILE_TOO_LARGE`.

Rollback reuses some of these codes at non-`400` statuses: `INVALID_PATH` at `404`
when there's no ready version of that number, and `VERSION_UNAVAILABLE` at `409`
when the target was pruned during the swap. Unpublish returns `CANNOT_UNPUBLISH`
at `409` when the canvas isn't currently published.

The read-back (`GET …/files`) returns `NOT_PUBLISHED` at `404` when the canvas has
no live version, and `NOT_FOUND` at `404` when `?path=` names a file that isn't in
the live manifest.

Auth, size, and rate-limit failures use their own shapes:

| Status | Body | Cause |
|---|---|---|
| `400` | `{ "code": "EMPTY_DEPLOY", ... }` | empty request body on deploy |
| `401` | `{ "error": "unauthorized" }` | missing or unknown Bearer key |
| `403` | `{ "error": "unauthorized" }` | key resolves to a different canvas than `{id}` |
| `413` | `{ "code": "CANVAS_TOO_LARGE", ... }` | body over the size cap |
| `429` | `{ "error": "rate_limited" }` | over 10/min for this canvas (`Retry-After` header) |

A key used against a canvas it does not own returns `403`, not `404`.
