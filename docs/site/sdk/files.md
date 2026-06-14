# File storage

`canvasdrop.files` stores files for the canvas and serves them from a content
URL you can drop into `<img>` or `<a>`.

```js
const f = await canvasdrop.files.upload(input.files[0]); // { id, name, size, url }
const all = await canvasdrop.files.list();               // FileMeta[]
const href = canvasdrop.files.url(f.id);                 // content URL (synchronous)
await canvasdrop.files.delete(f.id);
```

## Methods

| Method | Returns |
| --- | --- |
| `upload(file)` | `{ id, name, size, url }` — `file` is a `File`; `url` points at the file's content |
| `list()` | `FileMeta[]` — `{ id, name, size, mime?, createdAt? }` |
| `delete(id)` | `void` |
| `url(id)` | content URL string (synchronous; no request) |

`upload` posts a `multipart/form-data` request; the returned object carries only
`{ id, name, size, url }`. Use `list()` when you need `mime` or `createdAt`.

## Safety

- `url(id)` and the uploaded content are served with `X-Content-Type-Options:
  nosniff`, and SVG uploads are served as attachments rather than rendered inline,
  so an uploaded file can't run as another viewer.

## Errors

Files enforce a per-file size limit and a per-canvas quota, both admin-tunable.

- Oversized upload throws `QuotaExceededError` (HTTP `413`, code `FILE_TOO_LARGE`).
- Quota reached throws `QuotaExceededError` (HTTP `409`).
- A disabled capability throws `CapabilityDisabledError` (HTTP `403`,
  code `CAPABILITY_DISABLED`).
- A missing or deleted file throws `NotFoundError` (HTTP `404`).

See [error codes](/docs/api/errors).

The underlying HTTP endpoints are documented in the
[Runtime API](/docs/api/runtime-api).
