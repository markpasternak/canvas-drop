# Key–value storage

`canvasdrop.kv` is JSON key–value storage scoped to the canvas. Two namespaces:
**shared** (canvas-global) and **user** (auto-scoped to the signed-in viewer).

## Shared

```js
await canvasdrop.kv.set("votes", 0);
const n = await canvasdrop.kv.get("votes");            // value, or null if absent
const total = await canvasdrop.kv.increment("votes");  // atomic +1
await canvasdrop.kv.delete("votes");
const { entries, nextCursor } = await canvasdrop.kv.list({ prefix: "p:", limit: 100 });
```

`increment` is atomic — safe for concurrent polls, counters, and votes.

## Per-viewer

```js
await canvasdrop.kv.user.set("pref", "dark");
const pref = await canvasdrop.kv.user.get("pref");
```

The user namespace is keyed by the signed-in viewer, so each person reads and
writes their own values without the canvas managing identity.

## Limits

- Values up to **64 KB** (JSON).
- Keys up to **512 bytes**.
- **10,000** keys per canvas, **1,000** per user namespace.

Exceeding a limit throws a `QuotaExceededError`. A disabled capability throws
`CapabilityDisabledError`. See [error codes](/docs/api/errors).

The underlying HTTP endpoints are documented in the
[Runtime API](/docs/api/runtime-api).
