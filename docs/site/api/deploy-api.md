# Deploy API

Ship a canvas over HTTP — from CI, a script, or an AI agent — with **no dashboard
session**. Authenticate with the canvas's **secret key** as a Bearer token. A key
operates only on its own canvas, and every response is machine-readable so an agent
can repair and retry without a human.

> **Auth:** `Authorization: Bearer cd_...` — the canvas secret key, not a session
> cookie. The key format is `cd_<base64url-32B>`; it is shown once at creation and
> stored hashed (SHA-256). This path takes no cookies and no CORS, and is distinct
> from the session-cookie auth the [Runtime API](/docs/api/runtime-api) and browser
> SDK use.

Base path: `{base}/v1/canvases/{id}`. `{id}` is the canvas id (not the slug).

## Deploy a version

```
PUT {base}/v1/canvases/{id}/deploy
Authorization: Bearer cd_...
Content-Type: application/zip
<zip body>
```

The raw request body is ingested as a **ZIP** (put `index.html` at its root). A new
version is created and the canvas points at it. Deploys via this key are attributed
to the canvas owner and audited as `source: "api"`.

```bash
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
buffering; an over-limit body returns `413 CANVAS_TOO_LARGE`.

**Rate limit:** 10 deploys/min per canvas. Over-limit returns `429 { "error":
"rate_limited" }` with a `Retry-After` header.

## Get a canvas

```
GET {base}/v1/canvases/{id}
Authorization: Bearer cd_...
```

Returns `{ id, slug, url, title, status, currentVersionId }`.

## List versions

```
GET {base}/v1/canvases/{id}/versions
Authorization: Bearer cd_...
```

Returns one entry per version: `{ number, source, status, createdBy, createdAt,
fileCount, totalBytes, current }`.

## Roll back

```
POST {base}/v1/canvases/{id}/rollback
Authorization: Bearer cd_...
Content-Type: application/json

{ "version": 5 }
```

Points the canvas back at version `5`. Returns `{ url, version }`.

- `404 INVALID_PATH` — no ready version with that number.
- `409 VERSION_UNAVAILABLE` — the target version was pruned out from under the request.

## Errors

Validation failures return a stable `code` so agents can repair from the body:

```json
{ "code": "<DeployErrorCode>", "message": "...", "path": "<offending path, optional>" }
```

All `DeployError` validation failures are **`400`**. Codes: `EMPTY_DEPLOY`,
`TOO_MANY_FILES`, `FILE_TOO_LARGE`, `CANVAS_TOO_LARGE`, `ZIP_SLIP_REJECTED`,
`ZIP_BOMB_REJECTED`, `INVALID_ZIP`, `INVALID_PATH`, `PATH_EXISTS`,
`VERSION_UNAVAILABLE`. See [Error codes](/docs/api/errors) for the full table.

Auth and limit failures use their own shapes:

| Status | Body | Cause |
|---|---|---|
| `400` | `{ "code": "EMPTY_DEPLOY", "message": "empty body" }` | empty request body on deploy |
| `401` | `{ "error": "unauthorized" }` | missing or unknown Bearer key |
| `403` | `{ "error": "unauthorized" }` | key resolves to a different canvas than `{id}` |
| `413` | `{ "code": "CANVAS_TOO_LARGE", ... }` | body over the size cap |
| `429` | `{ "error": "rate_limited" }` | over 10 deploys/min for this canvas (`Retry-After` header) |

A key used against a canvas it does not own returns `403`, not `404`.
