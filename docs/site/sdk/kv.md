# Key–value storage

Persist JSON values from your canvas with `canvasdrop.kv` — counters, settings,
small documents, anything you'd otherwise lose on reload. The global
`canvasdrop` client is available on any served canvas; no setup, no API keys.

Two namespaces share the same five methods (`get`, `set`, `delete`, `list`,
`increment`):

- **shared** — `canvasdrop.kv` — one set of keys for the whole canvas.
- **per-viewer** — `canvasdrop.kv.user` — auto-scoped to the signed-in viewer
  server-side, so each person reads and writes their own values.

Identity comes from the session, never from your code, so there are no
credentials to handle.

## Shared

```js
await canvasdrop.kv.set("votes", 0);            // value is any JSON-serializable
const n = await canvasdrop.kv.get("votes");     // value, or null if absent
const total = await canvasdrop.kv.increment("votes");      // atomic, +1 by default
const stepped = await canvasdrop.kv.increment("votes", 5); // atomic, +5
await canvasdrop.kv.delete("votes");
const { entries, nextCursor } = await canvasdrop.kv.list({ prefix: "p:", limit: 100 });
```

`increment(key, by = 1)` is atomic and returns the new number — safe for
concurrent polls, counters, and votes. It throws `NOT_NUMERIC` (409) if the
stored value isn't a number. `set(key, value)` and `delete(key)` return nothing.

`get<T>(key)` returns the stored value (typed as `T`, default `unknown`) or
`null` when the key is absent. `list(opts?)` takes `{ prefix?, cursor?, limit? }`
and returns `{ entries: [{ key, value }], nextCursor }`; pass `nextCursor` back
as `cursor` to page.

## Per-viewer

```js
await canvasdrop.kv.user.set("pref", "dark");
const pref = await canvasdrop.kv.user.get("pref");
```

`canvasdrop.kv.user` is keyed by the signed-in viewer (the scope is forced to
their user ID on the server), so each person reads and writes their own values.
Same five methods (`get`, `set`, `delete`, `list`, `increment`) — only the scope
differs.

## Limits

- Values up to **64 KiB** (JSON) — `set` throws `VALUE_TOO_LARGE` (413) above it.
- Keys up to **512 bytes** — `set`/`increment` throw `KEY_TOO_LARGE` (413) above it.
- **10,000** keys per shared canvas, **1,000** per per-viewer namespace — a `set`
  or `increment` that would add a new key past the cap throws `KEY_LIMIT` (409).

The per-canvas key-count caps (shared and per-viewer) are admin-tunable per
instance; the 64 KiB value and 512-byte key limits are fixed.

These error codes surface as a `QuotaExceededError` carrying the wire `.code`. A
disabled capability throws `CapabilityDisabledError`. See
[error codes](/docs/api/errors).

The underlying HTTP endpoints are documented in the
[Runtime API](/docs/api/runtime-api).
