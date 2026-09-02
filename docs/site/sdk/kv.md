# Key–value storage

Keep state that survives a reload: counters, settings, form submissions, small
JSON documents. `canvasdrop.kv` lives on the `canvasdrop` global that
`<script src="/sdk/v1.js">` defines in every canvas; there is nothing to
configure and no key to hold. The canvas needs **Enable backend** on and the
**Key-value storage** toggle on (it is pre-enabled); see
[Capabilities](/docs/authoring/capabilities).

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  await canvasdrop.kv.set("votes", 0);                        // any JSON value except null
  const n = await canvasdrop.kv.get("votes");                 // the value, or null if absent
  const total = await canvasdrop.kv.increment("votes");       // atomic +1, returns the new total
  const stepped = await canvasdrop.kv.increment("votes", 5);  // atomic +5
  const page = await canvasdrop.kv.list({ prefix: "p:", limit: 100 }); // { entries, nextCursor }
  await canvasdrop.kv.delete("votes");                        // idempotent
</script>
```

Two scopes expose the same five methods:

- **Shared**: `canvasdrop.kv`. One set of keys for the whole canvas; every
  viewer reads and writes the same values.
- **Per-viewer**: `canvasdrop.kv.user`. Keys scoped to the signed-in viewer on
  the server, so each person sees only their own values.

## Methods

Signatures as declared in the SDK (`KvNamespace`):

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

`get(key)` resolves to the stored value, or `null` when the key does not exist.
The type parameter is a convenience for your own code; nothing is validated at
runtime. Because `null` means "absent", the server refuses to store a JSON
`null` (`INVALID_BODY`, 400); `delete` the key instead.

`set(key, value)` writes any other JSON value (string, number, boolean, object,
array) and overwrites what was there; the last write wins. Keys are any string;
the SDK URL-encodes them for you.

`delete(key)` removes the key. Deleting a key that does not exist succeeds and
does nothing.

`increment(key, by = 1)` adds `by` to a numeric value in a single atomic
statement on the server, so concurrent increments never lose an update. A
missing key starts at `0`. `by` may be negative or fractional but must be a
finite number. It resolves to the new total and rejects with `NOT_NUMERIC`
(409) when the stored value is not a number.

`list(opts)` returns entries in ascending key order, optionally filtered by
`prefix`. `limit` defaults to `100` and is clamped to `1..1000`. `nextCursor` is
`null` on the last page; otherwise pass it back as `cursor` for the next page.

```js
let cursor;
do {
  const page = await canvasdrop.kv.list({ prefix: "entry:", cursor, limit: 500 });
  for (const { key, value } of page.entries) render(key, value);
  cursor = page.nextCursor;
} while (cursor);
```

There is no batch, TTL, or transaction API. `increment` is the only
read-modify-write the server performs atomically; for anything else, design keys
so each writer owns its own.

## Per-viewer

```js
await canvasdrop.kv.user.set("theme", "dark");
const theme = await canvasdrop.kv.user.get("theme"); // this viewer's value only
```

`canvasdrop.kv.user` has the same five methods; only the scope differs. The
server derives the scope from the viewer's session identity and never from
anything your code sends, so one viewer cannot read or write another viewer's
keys. There is no way to enumerate other viewers' per-viewer data from a canvas.

## Limits

| Limit | Value | Error when exceeded |
| --- | --- | --- |
| Key size | 512 bytes (UTF-8) | `KEY_TOO_LARGE` (413) |
| Value size, serialized JSON | 64 KiB | `VALUE_TOO_LARGE` (413) |
| Keys per canvas, shared scope | 10,000 | `KEY_LIMIT` (409) |
| Keys per viewer per canvas, per-viewer scope | 1,000 | `KEY_LIMIT` (409) |

The key-count caps are admin-tunable per instance; the key and value sizes are
fixed. `KEY_LIMIT` applies only when a `set` or `increment` would create a new
key; updating an existing key always succeeds.

Runtime API calls are also rate limited per viewer per canvas (120 per minute by
default; the operator sets `CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN`). Past the
limit, calls reject with `RATE_LIMITED` (429) and a `Retry-After` header; batch
writes or debounce hot counters rather than writing on every keystroke. Every
call counts toward the canvas's usage stats.

## Errors

Every method rejects with a `CanvasdropError` subclass; branch on `err.code`, or
catch the subclass you care about.

- `KEY_TOO_LARGE`, `VALUE_TOO_LARGE`, `KEY_LIMIT` throw `QuotaExceededError`
  with the wire code in `err.code` and the status in `err.status`.
- `NOT_NUMERIC` (409), `INVALID_BODY` (400), and `RATE_LIMITED` (429) throw a
  plain `CanvasdropError` with that `code`.
- KV switched off, or the canvas backend off, throws `CapabilityDisabledError`
  (`code: "CAPABILITY_DISABLED"`, 403); `err.message` carries the server's hint
  when it sends one.
- On a Public link canvas, viewers other than the owner and editors get
  `STATIC_ONLY` (403): public canvases are static-only and every primitive is
  refused.
- `get` never throws `NotFoundError`; the 404 is folded into `null`.

```js
try {
  await canvasdrop.kv.set("doc", bigObject);
} catch (err) {
  if (err.code === "VALUE_TOO_LARGE") showToast("Keep it under 64 KiB");
  else throw err;
}
```

See [error codes](/docs/api/errors) for the full list, and the
[Runtime API](/docs/api/runtime-api) for the HTTP endpoints under
`{base}/v1/c/{slug}/kv` and `{base}/v1/c/{slug}/kv/user` that these methods
call.
