# Data storage

Store settings, preferences, comments and responses that survive a reload. The
backend feature is **Key-value storage** (KV): it stores JSON values under keys.
The SDK exposes it as `canvasdrop.kv`. You can use simple key-value pairs directly
or organize authored records into named collections.

The canvas needs **Enable backend** on and the **Key-value storage** toggle on
(it is pre-enabled) in its **Backend** tab; see
[Capabilities](/docs/authoring/capabilities).

## Choose how to store your data

| What you need | SDK | Access model |
|---|---|---|
| Shared settings or simple values | `canvasdrop.kv` | Admitted viewers read; owners/editors write |
| A person's private preferences or draft | `canvasdrop.kv.user` | Only that person reads and writes |
| Comments, responses or other individually owned items | `canvasdrop.kv.collection(name)` | Each collection has its own configurable policy; the server records each item's author |

Use the [`submissions`](/docs/sdk/submissions) convenience API when you need one
private response per person. Use a collection when people can create multiple
items or the audience needs different read/update/delete rules.

## What a collection is

A **collection** is a named group of related data records within one canvas.
A `comments` collection contains individual comments; an `answers` collection
contains individual answers. Each record has an ID, a JSON value and a
server-assigned author. Collections use the KV primitive underneath, so they
require its feature switch rather than a separate backend feature.

**Permissions are settings attached to the collection.** They determine who can
read, create, update, delete or increment its records. The name identifies the
group; a preset initializes its access rules. Two collections can use the same
preset and still hold separate records. Changing permissions affects access to
existing records without moving them or changing their authors.

For example, `comments` can use Shared contributions so everyone can read and add
comments, while only authors and owners/editors can change or delete them.
`answers` can use Private submissions so each person sees their own responses
and owners/editors can review all responses. Both collections belong to the same
data-storage feature, with independent policies.

Add the collection in **Backend → Participation and permissions** and save its
policy before using it. The default initializes new resources only; changing it
does not rewrite existing policies. Use the same collection name in your canvas
code. Adding `comments` in settings configures storage access; your code still
provides the comment form, rendering and other application behavior. Existing raw
keys such as `comment:123` do not become collection records automatically.
See [Permissions and defaults](/docs/sdk/permissions) to choose or customize rules.

## Collection API

After configuring a `comments` collection with Shared contributions:

```js
const comments = canvasdrop.kv.collection("comments");
const comment = await comments.create({ text: "Clarify the chart", status: "open" });
// { id, authorId, value, updatedAt } — authorId is immutable, assigned by the server.
await comments.update(comment.id, { ...comment.value, status: "fixed" });
const page = await comments.list({ limit: 100 });
const rights = await comments.permissions();
// rights.update.own / rights.update.any; compare me().id with record.authorId for UI.
await canvasdrop.files.upload(file, { collection: "comments", recordId: comment.id });
// Requires File storage too; the attachment inherits the comment's permissions.
```

| Method | Result |
|---|---|
| `create(value)` | New record; multiple records per author |
| `get(id)` | Record or null if absent/inaccessible |
| `update(id, value)` | Updated record; author unchanged |
| `delete(id)` | Delete a permitted record and clean up its attachments |
| `list({limit?, cursor?})` | `{entries, nextCursor}` filtered before pagination |
| `clear()` | `{deleted, attachmentCleanupFailed}` for permitted records only |
| `increment(id, by = 1)` | Updated numeric record; atomic, requires increment permission |
| `permissions()` | Effective read/create/update/delete/increment rights, each `{own, any}` |
| `count()` | Total record count, only if `aggregateCount` explicitly permits it |

Values are JSON including null, with a 64 KiB request limit. Pagination defaults
to 100, accepts 1–1000 and uses the opaque returned cursor. The existing admin KV
limits apply separately across authored collections: 10,000 records per canvas
and 1,000 per author by default. Creation limits are best-effort under concurrent
requests, like existing KV quotas. Updates at the limit remain available.

Count is opt-in and reveals only the collection size. It does not publish private
answers or arbitrary field aggregates. For votes, store authored responses and
publish a validated result through managed data; allowing a shared counter
increment is not a one-vote-per-person rule. See the
[collection HTTP routes and errors](/docs/api/runtime-api#authored-collections-and-resource-permissions).

## Shared and personal key-value API

The rest of this page covers simple values stored with `kv` and `kv.user`.
Their methods and fixed access rules are separate from the collection API above.

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  // These shared mutations require the owner or editor role.
  await canvasdrop.kv.set("votes", 0);                        // any JSON value except null
  const n = await canvasdrop.kv.get("votes");                 // 0 (null if the key is absent)
  const total = await canvasdrop.kv.increment("votes");       // 1, atomic +1
  const stepped = await canvasdrop.kv.increment("votes", 5);  // 6, atomic +5
  const page = await canvasdrop.kv.list({ prefix: "p:", limit: 100 }); // { entries, nextCursor }
  await canvasdrop.kv.delete("votes");                        // idempotent
</script>
```

### Two scopes, one interface

| Scope | Namespace | Who shares the keys | HTTP base |
| --- | --- | --- | --- |
| Shared | `canvasdrop.kv` | Admitted viewers read; only owners and editors set, delete or increment | `{base}/v1/c/{slug}/kv` |
| Per-viewer | `canvasdrop.kv.user` | Only the signed-in viewer; each person sees their own values | `{base}/v1/c/{slug}/kv/user` |

Both namespaces have the same five methods (`KvNamespace`). The server derives
the per-viewer scope from the viewer's session identity, never from anything
your code sends, so one viewer cannot read or write another viewer's keys, and
a canvas has no way to enumerate other viewers' per-viewer data.

```js
await canvasdrop.kv.user.set("theme", "dark");
const theme = await canvasdrop.kv.user.get("theme"); // this viewer's value only
```

### Methods

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

#### get

`get(key)` resolves to the stored value, or `null` when the key does not exist.
The `404` never surfaces as an error; the SDK folds `NotFoundError` into `null`.
The type parameter is a convenience for your own code; nothing is validated at
runtime.

#### set

`set(key, value)` writes any JSON value except `null` (string, number, boolean,
object, array) and overwrites what was there; the last write wins. Because
`null` means "absent" on read, the server refuses to store a JSON `null`
(`INVALID_BODY`, 400, `value must not be null`); `delete` the key instead.

#### delete

`delete(key)` removes the key. Deleting a key that does not exist succeeds and
does nothing.

#### increment

`increment(key, by = 1)` adds `by` to a numeric value in one atomic upsert on
the server, so concurrent increments never lose an update. A missing key starts
at `0`. `by` may be negative or fractional but must be a finite number
(`INVALID_BODY`, 400, `by must be a finite number` otherwise). It resolves to the
new total and rejects with `NOT_NUMERIC` (409) when the stored value is not a
number. `increment` is the only read-modify-write the server performs
atomically; there is no batch, TTL, compare-and-set, or transaction API. For
anything else, design keys so each writer owns its own.

#### list

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

### Limits

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

### Errors

Every method rejects with a `CanvasdropError` subclass; branch on `err.code`
(the wire code) and `err.status`, or catch the subclass you care about.

| What happened | `err.code` | Status | Class |
| --- | --- | --- | --- |
| Viewer attempts a shared mutation | `PERMISSION_DENIED` | 403 | `PermissionDeniedError` |
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

### HTTP calls behind each method

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
