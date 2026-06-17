# Error codes

When a primitive call fails, branch on the error's `code` — never on message
text. Every failure from the runtime API carries a stable, machine-readable
`code` and an HTTP `status`, and the browser SDK throws typed errors extending
`CanvasdropError` (each with a readonly `.code` and `.status`).

The global is `window.canvasdrop` (loaded from `/sdk/v1.js`); the error classes
are also named exports of `@canvas-drop/sdk`. There is no `cd` alias.

```js
try {
  await canvasdrop.kv.set("prefs", { theme: "dark" });
} catch (err) {
  if (err.code === "QUOTA_EXCEEDED") showQuotaBanner();
  else throw err;
}
```

`kv.get` already returns `null` instead of throwing on a missing key, so most
reads don't need a `try/catch`; the example shows the general pattern.

## The codes

This table is the SDK's exported `ERROR_CODES`, verbatim. Each entry is
`{ status, summary }`.

| Code | Status | Meaning |
|------|--------|---------|
| `NOT_AUTHENTICATED` | 401 | The viewer is not signed in. |
| `PASSWORD_REQUIRED` | 403 | The canvas is password-protected. |
| `CAPABILITY_DISABLED` | 403 | Backend or the specific feature is off for this canvas. |
| `CROSS_CANVAS_FORBIDDEN` | 403 | A request targeted another canvas's resources. |
| `MODEL_NOT_ALLOWED` | 403 | The requested AI model is not in the allow-list. |
| `DISABLED` | 403 | The canvas has been disabled by an administrator. |
| `STATIC_ONLY` | 403 | The canvas is a public link (`public_link`) — every backend primitive is refused for non-owners. |
| `GUEST_AI_DISABLED` | 403 | The canvas owner has not enabled AI for invited guests. |
| `GUEST_AI_CAP` | 429 | The canvas reached its guest-AI spend cap. |
| `NOT_FOUND` | 404 | The key, file, or canvas does not exist. |
| `INVALID_BODY` | 400 | The request body failed validation. |
| `KEY_TOO_LARGE` | 413 | The KV key exceeds the size limit. |
| `VALUE_TOO_LARGE` | 413 | The KV value exceeds the size limit. |
| `FILE_TOO_LARGE` | 413 | An uploaded file exceeds the per-file size limit. |
| `KEY_LIMIT` | 409 | The canvas hit its key-count limit. |
| `NOT_NUMERIC` | 409 | `increment` was called on a non-numeric value. |
| `QUOTA_EXCEEDED` | 429 | A spend or rate quota was exceeded. |
| `CONNECTION_LIMIT` | 429 | Too many concurrent realtime connections. |
| `AI_STREAM_TRUNCATED` | 502 | An AI stream ended before completion. |
| `AI_UPSTREAM_ERROR` | 502 | The AI provider returned an error. |
| `REQUEST_FAILED` | 0 | A request failed without a more specific code. |

`REQUEST_FAILED` carries status `0` — it's the fallback when a request fails
without a more specific code.

## Typed SDK errors

The SDK exports four `CanvasdropError` subclasses. Any code without a dedicated
subclass is thrown as the base `CanvasdropError` with its `.code` set from the
table above.

| Class | `.code` | `.status` |
|-------|---------|-----------|
| `NotAuthenticatedError` | `NOT_AUTHENTICATED` | 401 |
| `CapabilityDisabledError` | `CAPABILITY_DISABLED` | 403 |
| `NotFoundError` | `NOT_FOUND` | 404 |
| `QuotaExceededError` | `QUOTA_EXCEEDED` (default) | 409 (default) |
| `CanvasdropError` (base) | any code | any status |

`QuotaExceededError` is the one quota-shaped class, so it's reused for related
limits: the SDK constructs it with the actual wire `code` and `status` for 409
and 413 responses (e.g. `KEY_LIMIT`, `VALUE_TOO_LARGE`, `KEY_TOO_LARGE`), for the
guest-AI cap (`code: "GUEST_AI_CAP"`, `status: 429`), and realtime constructs it
with `code: "CONNECTION_LIMIT"`, `status: 429`. Always read `err.code`/`err.status`
— don't assume a `QuotaExceededError` is literally `QUOTA_EXCEEDED`.

Classes such as `CrossCanvasForbiddenError`, `ModelNotAllowedError`, and
`PasswordRequiredError` do **not** exist; those codes arrive on the base
`CanvasdropError`. Branching on `err.code` is the only reliable check.

## AI stream errors

`ai.chat` / `ai.stream` consume a server-sent stream. Failures surface two ways:

- **Before the stream starts** (an HTTP error) — thrown as a typed error per the
  tables above, e.g. `MODEL_NOT_ALLOWED` (403), `QUOTA_EXCEEDED` (429), or
  `CAPABILITY_DISABLED` (403).
- **Mid-stream** — an `error` frame maps to `CAPABILITY_DISABLED` →
  `CapabilityDisabledError`, `QUOTA_EXCEEDED` → `QuotaExceededError`, otherwise a
  base `CanvasdropError` with the frame's `code` and status `502` (typically
  `AI_UPSTREAM_ERROR`).

If the stream ends without a terminal `done` or `error` frame, the SDK throws
`AI_STREAM_TRUNCATED` (502).

## Realtime close codes

A terminal WebSocket close maps to a typed error (no reconnect):

| Close code | Error |
|------------|-------|
| `4403` | `CapabilityDisabledError` (`realtime` off) |
| `4401` | `NotAuthenticatedError` |
| `4429` | `QuotaExceededError` (`CONNECTION_LIMIT`, status 429) |
