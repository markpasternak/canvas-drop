# File storage

Let viewers upload files to your canvas and get back a URL you can put in an
`<img>`, a link, or a `fetch()`. `canvasdrop.files` is on the global
`canvasdrop` client that every served canvas gets from
`<script src="/sdk/v1.js">`; there is nothing to configure and no key to hold.
Switch on the files capability for the canvas first (see
[Capabilities](/docs/authoring/capabilities)).

```js
const f = await canvasdrop.files.upload(input.files[0]); // { id, name, size, url }
img.src = f.url;                                          // absolute content URL

const all = await canvasdrop.files.list();                // FileMeta[]
const href = canvasdrop.files.url(f.id);                  // same URL, no request
await canvasdrop.files.delete(f.id);
```

Files belong to the canvas, not to the viewer who uploaded them: every viewer
who can open the canvas can list, read, and delete every file in it.

## Methods

Signatures as declared in the SDK (`CanvasdropClient.files`):

| Method | Signature |
| --- | --- |
| `upload` | `upload(file: File): Promise<{ id: string; name: string; size: number; url: string }>` |
| `list` | `list(): Promise<FileMeta[]>` |
| `delete` | `delete(id: string): Promise<void>` |
| `url` | `url(id: string): string` |

```ts
interface FileMeta {
  id: string;
  name: string;
  size: number;      // bytes
  mime?: string;
  createdAt?: number;
}
```

`upload(file)` posts the `File` as `multipart/form-data` under the field name
`file`. The stored name is `file.name` (or `upload` when the `File` has none)
and the stored MIME type is `file.type` (or `application/octet-stream`). It
resolves to `{ id, name, size, url }` only; call `list()` when you need `mime`
or `createdAt`. There is no progress callback; for a large file, show your own
pending state around the `await`.

`list()` returns every file in the canvas with its metadata.

`delete(id)` removes the file and its bytes. It rejects with `NotFoundError`
when `id` does not exist.

`url(id)` builds the content URL synchronously from the id, without a request.
It is the same value `upload` returns in `url`.

## Content URLs

`f.url` and `canvasdrop.files.url(id)` both resolve to
`{base}/v1/c/{slug}/files/{id}/content`, absolute and correct for the URL mode
the instance runs in. In path mode that is the canvas's own origin; in subdomain
mode it is the base host, and the response carries the credentialed CORS headers
your canvas origin needs. The SDK detects the mode from `location`, so you never
build this URL by hand.

Content is served behind the same sign-in as the canvas. An `<img src>` works
directly. When you `fetch()` a content URL yourself, send credentials so the
request succeeds in subdomain mode too:

```js
const res = await fetch(canvasdrop.files.url(id), { credentials: "include" });
const blob = await res.blob();
```

A content URL for an id that does not exist returns `404` with
`{ "code": "NOT_FOUND" }`.

Content requests count toward the same per-viewer runtime rate limit as every
other SDK call (120 requests per minute per canvas by default; the operator sets
`CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN`). A page that loads hundreds of
images at once can hit `RATE_LIMITED` (429); lazy-load or paginate large
galleries.

## How content is served

Uploaded bytes come from other people, so the content endpoint treats them as
untrusted:

- `X-Content-Type-Options: nosniff` on every response.
- `Content-Disposition: inline` only for `image/png`, `image/jpeg`, `image/gif`,
  `image/webp`, and `image/avif`. Everything else, SVG and HTML included, is
  served as an `attachment` and downloads instead of rendering.
- The filename in `Content-Disposition` is sanitized and RFC 5987 encoded.

This keeps an uploaded active document (HTML, or a scriptable SVG) from
running against another viewer's session on the canvas origin.

## Limits

| Limit | Default | Error when exceeded |
| --- | --- | --- |
| Bytes per file | 25 MiB | `FILE_TOO_LARGE` (413) |
| Bytes per canvas, all files | 1 GiB | `QUOTA_EXCEEDED` (409) |

Both are admin-tunable per instance (`files.bytes.file`, `files.bytes.canvas`).
The request body itself is capped at 25 MiB plus 1 MiB of multipart framing, and
that transport cap is fixed, so raising the per-file setting above 25 MiB has no
effect on uploads through the SDK.

## Errors

Every method rejects with a `CanvasdropError` subclass; branch on `err.code`, or
catch the subclass you care about.

- `FILE_TOO_LARGE` (413) and `QUOTA_EXCEEDED` (409) throw `QuotaExceededError`
  with the wire code in `err.code` and the status in `err.status`.
- `INVALID_BODY` (400) throws a plain `CanvasdropError`: the request was not
  multipart, or the `file` field was missing or not a `File`.
- `NOT_FOUND` (404) from `delete` throws `NotFoundError`.
- Files switched off, or the canvas backend off, throws `CapabilityDisabledError`
  (`code: "CAPABILITY_DISABLED"`, 403); `err.message` carries the server's hint
  when it sends one.
- On a Public link canvas, viewers other than the owner and editors get
  `STATIC_ONLY` (403): public canvases are static-only and every primitive is
  refused.
- `RATE_LIMITED` (429) throws a plain `CanvasdropError`; the response carries a
  `Retry-After` header.

```js
try {
  const f = await canvasdrop.files.upload(file);
  img.src = f.url;
} catch (err) {
  if (err.code === "FILE_TOO_LARGE") showToast("Keep files under 25 MiB");
  else if (err.code === "QUOTA_EXCEEDED") showToast("This canvas is out of file storage");
  else throw err;
}
```

See [error codes](/docs/api/errors) for the full list, and the
[Runtime API](/docs/api/runtime-api) for the HTTP endpoints under
`/v1/c/{slug}/files` that these methods call.
