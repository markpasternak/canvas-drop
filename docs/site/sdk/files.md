# File storage

`canvasdrop.files` stores files for the canvas and serves them from a same-origin
URL you can drop into `<img>` or `<a>`.

```js
const f = await canvasdrop.files.upload(input.files[0]); // { id, name, size, url }
const all = await canvasdrop.files.list();
const href = canvasdrop.files.url(f.id);                 // same-origin content URL
await canvasdrop.files.delete(f.id);
```

## Limits and safety

- **25 MB** per file, **1 GB** per canvas.
- Downloads are served as attachments; uploaded HTML/SVG is never rendered inline,
  so an uploaded file can't run as another viewer.

Exceeding a limit throws a `QuotaExceededError`; a disabled capability throws
`CapabilityDisabledError`. See [error codes](/docs/api/errors).

The underlying HTTP endpoints are documented in the
[Runtime API](/docs/api/runtime-api).
