# Key-value storage

Store JSON that outlives a reload, from a static canvas, with no server code:
counters, settings, form submissions, small documents. This page is the
reference for `canvasdrop.kv`, the KV primitive on the `canvasdrop` global that
`<script src="/sdk/v1.js">` defines in every canvas. By the end you can read,
write, count, and page through keys in both scopes and handle every error KV
returns.

The canvas needs **Enable backend** on and the **Key-value storage** toggle on
(it is pre-enabled) in its **Backend** tab; see
[Capabilities](/docs/authoring/capabilities).

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  await canvasdrop.kv.set("votes", 0);                        // any JSON value except null
  const n = await canvasdrop.kv.get("votes");                 // 0 (null if the key is absent)
  const total = await canvasdrop.kv.increment("votes");       // 1, atomic +1
  const stepped = await canvasdrop.kv.increment("votes", 5);  // 6, atomic +5
  const page = await canvasdrop.kv.list({ prefix: "p:", limit: 100 }); // { entries, nextCursor }
  await canvasdrop.kv.delete("votes");                        // idempotent
</script>
```

## Two scopes, one interface

| Scope | Namespace | Who shares the keys | HTTP base |
| --- | --- | --- | --- |
| Shared | `canvasdrop.kv` | Every viewer of the canvas reads and writes the same values | `{base}/v1/c/{slug}/kv` |
| Per-viewer | `canvasdrop.kv.user` | Only the signed-in viewer; each person sees their own values | `{base}/v1/c/{slug}/kv/user` |

Both namespaces have the same five methods (`KvNamespace`). The server derives
the per-viewer scope from the viewer's session identity, never from anything
your code sends, so one viewer cannot read or write another viewer's keys, and
a canvas has no way to enumerate other viewers' per-viewer data.

```js
await canvasdrop.kv.user.set("theme", "dark");
const theme = await canvasdrop.kv.user.get("theme"); // this viewer's value only
```

## Methods

Signatures as declared in the SDK:

| Method | Signature |
| --- | --- |
| `get` | `get<T = unknown>(key: string): Promise<T \| null>` |
| `set` | `set(key: string, value: unknown): Promise<void>` |
| `delete` | `delete(key: string): Promise<void>` |
| `list` | `list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<KvList>` |
| `increment` | `increment(key: string, by?: number): Promise<number>` |

```ts
interface KvList {
  entries: Array<{ key: string; value: unknown }>;
  nextCursor: string | null;
}
```

Keys are any string; the SDK URL-encodes them, so `/`, spaces, and Unicode are
fine. A key is at most 512 bytes of UTF-8 (see [Limits](#limits)).

### get

`get(key)` resolves to the stored value, or `null` when the key does not exist.
The `404` never surfaces as an error; the SDK folds `NotFoundError` into `null`.
The type parameter is a convenience for your own code; nothing is validated at
runtime.

### set

`set(key, value)` writes any JSON value except `null` (string, number, boolean,
object, array) and overwrites what was there; the last write wins. Because
`null` means "absent" on read, the server refuses to store a JSON `null`
(`INVALID_BODY`, 400, `value must not be null`); `delete` the key instead.

### delete

`delete(key)` removes the key. Deleting a key that does not exist succeeds and
does nothing.

### increment

`increment(key, by = 1)` adds `by` to a numeric value in one atomic upsert on
the server, so concurrent increments never lose an update. A missing key starts
at `0`. `by` may be negative or fractional but must be a finite number
(`INVALID_BODY`, 400, `by must be a finite number` otherwise). It resolves to the
new total and rejects with `NOT_NUMERIC` (409) when the stored value is not a
number. `increment` is the only read-modify-write the server performs
atomically; there is no batch, TTL, compare-and-set, or transaction API. For
anything else, design keys so each writer owns its own.

### list

`list(opts)` returns entries in ascending key order. `prefix` is a literal
string match. `limit` defaults to `100`; the server clamps it to `1..1000`.
`nextCursor` is the last key of the page when more entries remain and `null` on
the last page; pass it back as `cursor` to continue.

```js
let cursor;
do {
  const page = await canvasdrop.kv.list({ prefix: "entry:", cursor, limit: 500 });
  for (const { key, value } of page.entries) render(key, value);
  cursor = page.nextCursor;
} while (cursor);
```

## Limits

| Limit | Value | Error when exceeded |
| --- | --- | --- |
| Key size | 512 bytes (UTF-8) | `KEY_TOO_LARGE` (413) |
| Value size, serialized JSON | 64 KiB | `VALUE_TOO_LARGE` (413) |
| Keys per canvas, shared scope | 10,000 | `KEY_LIMIT` (409) |
| Keys per viewer per canvas, per-viewer scope | 1,000 | `KEY_LIMIT` (409) |

The key-count caps are admin-tunable per instance; the key and value sizes are
fixed. `KEY_LIMIT` applies only when a `set` or `increment` would create a new
key; updating an existing key always succeeds. The server checks a `set` in
this order: key size, body parses as JSON, not `null`, value size, key count.
An `increment` checks key size, `by`, key count, then the stored type.

Runtime API calls are rate limited per viewer per canvas: 120 per minute by
default (`CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN`), shared by every Runtime API
call that viewer makes on that canvas except AI, which has its own bucket. Past
the limit, calls reject with `RATE_LIMITED` (429) and a `Retry-After` header;
debounce hot counters rather than writing on every keystroke. Every call counts
toward the canvas's usage stats, and `set`, `delete`, and `increment` are
recorded in the instance audit log.

## Errors

Every method rejects with a `CanvasdropError` subclass; branch on `err.code`
(the wire code) and `err.status`, or catch the subclass you care about.

| What happened | `err.code` | Status | Class |
| --- | --- | --- | --- |
| Key, value, or key count over a limit | `KEY_TOO_LARGE`, `VALUE_TOO_LARGE`, `KEY_LIMIT` | 413, 413, 409 | `QuotaExceededError` |
| `increment` on a non-number | `NOT_NUMERIC` | 409 | `CanvasdropError` |
| `set(key, null)` or a non-finite `by` | `INVALID_BODY` | 400 | `CanvasdropError` |
| Too many calls this minute | `RATE_LIMITED` | 429 | `CanvasdropError` |
| KV toggle off, or the canvas backend off | `CAPABILITY_DISABLED` | 403 | `CapabilityDisabledError`; `err.message` carries the server's hint |
| Public link canvas, caller is not the owner or an editor | `STATIC_ONLY` | 403 | `CanvasdropError`; public canvases are static-only and every primitive is refused |
| Password-protected canvas, gate not passed | `PASSWORD_REQUIRED` | 403 | `CanvasdropError`; the owner and editors never see it |
| Viewer's session has ended | `NOT_AUTHENTICATED` | 401 | `NotAuthenticatedError` in `dev` and `proxy` auth modes; in `oidc` mode the gateway redirects to sign-in instead. Either way, reload the page |

`get` never throws `NotFoundError`; the 404 is folded into `null`.

```js
try {
  await canvasdrop.kv.set("doc", bigObject);
} catch (err) {
  if (err.code === "VALUE_TOO_LARGE") showToast("Keep it under 64 KiB");
  else throw err;
}
```

## HTTP calls behind each method

Useful when you are reading the network tab or calling the
[Runtime API](/docs/api/runtime-api) directly. `{kv}` is `/v1/c/{slug}/kv` for
the shared scope and `/v1/c/{slug}/kv/user` for the per-viewer scope; the key
is one URL-encoded path segment.

| Method | Request | Success response |
| --- | --- | --- |
| `get(key)` | `GET {kv}/{key}` | `200 {"value": ...}`; `404 {"code":"NOT_FOUND"}` becomes `null` |
| `set(key, value)` | `PUT {kv}/{key}`, body is the raw JSON value | `200 {"ok":true}` |
| `delete(key)` | `DELETE {kv}/{key}` | `200 {"ok":true}` |
| `increment(key, by)` | `POST {kv}/{key}/increment`, body `{"by": 1}` | `200 {"value": 1}` |
| `list(opts)` | `GET {kv}?prefix=&cursor=&limit=` | `200 {"entries":[{"key","value"}],"nextCursor":null}` |

See [error codes](/docs/api/errors) for the full list across every primitive.
