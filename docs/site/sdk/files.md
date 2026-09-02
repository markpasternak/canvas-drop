# File storage

Let viewers upload files to a canvas and get back a URL you can put in an
`<img>`, a link, or a `fetch()`. This page is the reference for
`canvasdrop.files`, the files primitive on the `canvasdrop` global that
`<script src="/sdk/v1.js">` defines in every canvas. By the end you can upload,
list, serve, and delete files, and handle every error the primitive returns.

The canvas needs **Enable backend** on and the **File storage** toggle on (it is
pre-enabled) in its **Backend** tab; see
[Capabilities](/docs/authoring/capabilities). There is nothing to configure in
the page and no key to hold.

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  // <input type="file" id="picker"> and <img id="img"> are on the page
  const f = await canvasdrop.files.upload(picker.files[0]); // { id, name, size, url }
  img.src = f.url;                                           // absolute content URL

  const all = await canvasdrop.files.list();                 // FileMeta[]
  const href = canvasdrop.files.url(f.id);                   // same URL as f.url, no request
  await canvasdrop.files.delete(f.id);                       // the URL now returns 404
</script>
```

Files belong to the canvas, not to the viewer who uploaded them: every viewer
who can open the canvas can list, read, and delete every file in it. There is no
per-viewer scope for files (KV has `kv.user`; files has no equivalent). The
server records who uploaded each file for its audit trail, but the API does not
expose or filter by uploader.

## Methods

Signatures as declared in the SDK (`CanvasdropClient.files`), with the runtime
API call each one makes:

| Method | Signature | HTTP call |
| --- | --- | --- |
| `upload` | `upload(file: File): Promise<{ id: string; name: string; size: number; url: string }>` | `POST {base}/v1/c/{slug}/files` |
| `list` | `list(): Promise<FileMeta[]>` | `GET {base}/v1/c/{slug}/files` |
| `delete` | `delete(id: string): Promise<void>` | `DELETE {base}/v1/c/{slug}/files/{id}` |
| `url` | `url(id: string): string` | none (builds `{base}/v1/c/{slug}/files/{id}/content`) |

```ts
interface FileMeta {
  id: string;
  name: string;
  size: number;      // bytes
  mime?: string;     // always sent by the server
  createdAt?: number; // Unix ms; always sent by the server
}
```

### upload

`upload(file)` posts the `File` as `multipart/form-data` under the field name
`file`. The stored name is `file.name` (or `upload` when the `File` has none)
and the stored MIME type is `file.type` (or `application/octet-stream`). The
server answers `201 { id, name, size, url }` with a root-relative `url`; the SDK
replaces it with the absolute content URL before resolving, so `f.url` is
correct in both URL modes. The result carries no `mime` or `createdAt`; call
`list()` when you need them.

There is no progress callback and no upload option. For a large file, show your
own pending state around the `await`. Ids are server-assigned UUIDs.

### list

`list()` resolves to every file in the canvas, with its metadata, in one array.
There is no paging and no filter.

### delete

`delete(id)` removes the file row and its bytes. It rejects with `NotFoundError`
when `id` is not a file of this canvas, so deleting the same id twice rejects
the second call. After a delete, the file's content URL returns `404`.

### url

`url(id)` builds the content URL synchronously from the id, without a request.
It is the same value `upload` returns in `url`. It does not check that the id
exists.

Every call (upload, list, download, delete) counts in the canvas's usage stats;
uploads and deletes are also written to the audit log.

## Content URLs

`f.url` and `canvasdrop.files.url(id)` both resolve to
`{base}/v1/c/{slug}/files/{id}/content`, absolute and correct for the URL mode
the instance runs in. The SDK detects the mode from `location`, so you never
build this URL by hand.

| URL mode | Content URL origin | Cross-origin? |
| --- | --- | --- |
| `path` | the canvas's own origin | no |
| `subdomain` | the base host (`{base}`), not the canvas subdomain | yes; the response carries the credentialed CORS headers your canvas origin needs |

Content is served behind the same sign-in as the canvas and through the same
cross-canvas isolation as every other runtime API call, so use a file's URL from
the canvas that owns it. An `<img src>` works directly. When you `fetch()` a
content URL yourself, send credentials so the request succeeds in `subdomain`
mode too:

```js
const res = await fetch(canvasdrop.files.url(id), { credentials: "include" });
const blob = await res.blob();
```

A content URL for an id that does not exist returns `404` with
`{ "code": "NOT_FOUND" }`.

Content requests count toward the same per-viewer runtime rate limit as every
other SDK call: 120 requests per minute per viewer per canvas by default, set by
the operator with `CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN`. A page that loads
hundreds of images at once can hit `RATE_LIMITED` (429); lazy-load or paginate
large galleries.

## How content is served

Uploaded bytes come from other people, so the content endpoint treats them as
untrusted:

- `Content-Type` is the MIME type stored at upload, with
  `X-Content-Type-Options: nosniff` on every response.
- `Content-Disposition: inline` only for `image/png`, `image/jpeg`, `image/gif`,
  `image/webp`, and `image/avif`. Everything else, SVG and HTML included, is
  served as an `attachment` and downloads instead of rendering.
- The filename in `Content-Disposition` is sanitized (ASCII fallback) and
  RFC 5987 encoded (`filename*`).

This keeps an uploaded active document (HTML, or a scriptable SVG) from running
against another viewer's session on the canvas origin. If your canvas needs to
display an SVG a viewer uploaded, `fetch()` it and render it yourself in a way
that does not execute its scripts.

## Limits

| Limit | Default | Error when exceeded |
| --- | --- | --- |
| Bytes per file | 25 MiB | `FILE_TOO_LARGE` (413) |
| Bytes per canvas, all files | 1 GiB | `QUOTA_EXCEEDED` (409) |

Both defaults are admin-tunable per instance (Admin settings, **Limits** group:
**Max file bytes** and **Max canvas bytes**). The request body itself is capped
at 25 MiB plus 1 MiB of multipart framing, and that transport cap is a fixed
constant: an admin can lower the per-file limit, but raising it above 25 MiB has
no effect on uploads through the SDK. A body over the transport cap is refused
with the same `FILE_TOO_LARGE` (413) before the file is read.

The per-canvas quota is a check before the write, not a reservation. Two
uploads racing at the boundary can both succeed; this is acceptable on the
trusted-org model the platform is built for.

## Errors

Every method rejects with a `CanvasdropError` subclass; branch on `err.code`, or
catch the subclass you care about.

| Wire code | Status | Thrown as | When |
| --- | --- | --- | --- |
| `FILE_TOO_LARGE` | 413 | `QuotaExceededError` | the file, or the request body, is over the per-file limit |
| `QUOTA_EXCEEDED` | 409 | `QuotaExceededError` | the upload would push the canvas over its byte quota |
| `INVALID_BODY` | 400 | `CanvasdropError` | the request was not multipart, or the `file` field was missing or not a `File` |
| `NOT_FOUND` | 404 | `NotFoundError` | `delete` with an id that is not a file of this canvas |
| `CAPABILITY_DISABLED` | 403 | `CapabilityDisabledError` | the **File storage** toggle or the canvas backend is off |
| `STATIC_ONLY` | 403 | `CanvasdropError` | the canvas is on the **Public link** rung and the caller is not the owner or an editor |
| `RATE_LIMITED` | 429 | `CanvasdropError` | the per-viewer runtime rate limit was hit; the response carries `Retry-After` |

Notes:

- `QuotaExceededError` keeps the wire code in `err.code` and the status in
  `err.status`. Note the 409: on this route the per-canvas quota is a storage
  conflict, not the 429 that `QUOTA_EXCEEDED` means for AI spend.
- `CapabilityDisabledError` exposes the server's repair hint as `err.hint`, and
  `err.message` is that hint when the server sends one.
- On a **Public link** canvas every primitive is refused for non-owners; only
  the owner and the canvas's editors reach `canvasdrop.files` there.

```js
try {
  const f = await canvasdrop.files.upload(file);
  img.src = f.url;
} catch (err) {
  if (err.code === "FILE_TOO_LARGE") showToast("Keep files under 25 MiB");
  else if (err.code === "QUOTA_EXCEEDED") showToast("This canvas is out of file storage");
  else if (err.code === "CAPABILITY_DISABLED") showToast("File storage is off for this canvas");
  else throw err;
}
```

See [error codes](/docs/api/errors) for the full list, and the
[Runtime API](/docs/api/runtime-api) for the HTTP endpoints under
`/v1/c/{slug}/files` that these methods call.
