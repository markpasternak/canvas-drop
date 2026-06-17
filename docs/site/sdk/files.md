# File storage

Store files for your canvas and serve them from a content URL you can drop
straight into an `<img>` or `<a>`. The browser SDK is the global
`canvasdrop` — no keys, no setup.

```js
const f = await canvasdrop.files.upload(input.files[0]); // { id, name, size, url }
const all = await canvasdrop.files.list();               // FileMeta[]
const href = canvasdrop.files.url(f.id);                 // content URL (synchronous)
await canvasdrop.files.delete(f.id);
```

`f.url` and `canvasdrop.files.url(id)` both point at
`/v1/c/<slug>/files/<id>/content`, resolved to an absolute, mode-correct URL
(works in both path and subdomain mode).

## Methods

| Method | Returns |
| --- | --- |
| `upload(file)` | `Promise<{ id, name, size, url }>` — `file` is a `File`; `url` is the absolute content URL |
| `list()` | `Promise<FileMeta[]>` — `{ id, name, size, mime?, createdAt? }` |
| `delete(id)` | `Promise<void>` |
| `url(id)` | content URL string (synchronous; no request) |

`upload` posts a `multipart/form-data` request with the field name `file`. The
server responds with `{ id, name, size, url }` (the `url` is root-relative); the
SDK rewrites `url` to an absolute, mode-correct content URL. The returned object
carries only `{ id, name, size, url }` — use `list()` when you need `mime` or
`createdAt`.

## Safety

The content endpoint is served with `X-Content-Type-Options: nosniff`. Only safe
raster image types render inline; SVG is forced to a download (attachment) rather
than rendered, and the served filename is sanitized. An uploaded file can't run
as script against another viewer.

## Errors

Files enforce a per-file size limit and a per-canvas quota, both admin-tunable.
Every method rejects with a `CanvasdropError` subclass — catch the one you care
about, or read `err.code` / `err.status`.

- Oversized upload throws `QuotaExceededError` (HTTP `413`, `code: "FILE_TOO_LARGE"`).
- Quota reached throws `QuotaExceededError` (HTTP `409`).
- A disabled `files` capability throws `CapabilityDisabledError` (HTTP `403`,
  `code: "CAPABILITY_DISABLED"`).
- `delete(id)` on a missing file throws `NotFoundError` (HTTP `404`,
  `code: "NOT_FOUND"`).

See [error codes](/docs/api/errors).

The underlying HTTP endpoints are documented in the
[Runtime API](/docs/api/runtime-api).
