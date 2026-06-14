# Error codes

Every failure from the runtime and deploy APIs carries a stable, machine-readable
`code` and an HTTP `status`. The browser SDK maps these to typed errors extending
`CanvasdropError` (each with a `.code` and `.status`). Branch on `err.code` rather
than on message text.

This table is the canonical set; it is kept in lockstep with the SDK's exported
`ERROR_CODES`.

| Code | Status | Meaning |
|------|--------|---------|
| `NOT_AUTHENTICATED` | 401 | The viewer is not signed in. |
| `PASSWORD_REQUIRED` | 401 | The canvas is password-protected. |
| `CAPABILITY_DISABLED` | 403 | Backend or the specific feature is off for this canvas. |
| `CROSS_CANVAS_FORBIDDEN` | 403 | A request targeted another canvas's resources. |
| `MODEL_NOT_ALLOWED` | 403 | The requested AI model is not in the allow-list. |
| `DISABLED` | 403 | The canvas has been disabled by an administrator. |
| `NOT_FOUND` | 404 | The key, file, or canvas does not exist. |
| `INVALID_BODY` | 400 | The request body failed validation. |
| `KEY_TOO_LARGE` | 413 | The KV key exceeds the size limit. |
| `VALUE_TOO_LARGE` | 413 | The KV value or file exceeds the size limit. |
| `KEY_LIMIT` | 409 | The canvas hit its key-count limit. |
| `NOT_NUMERIC` | 409 | `increment` was called on a non-numeric value. |
| `QUOTA_EXCEEDED` | 429 | A spend or rate quota was exceeded. |
| `CONNECTION_LIMIT` | 429 | Too many concurrent realtime connections. |
| `AI_STREAM_TRUNCATED` | 502 | An AI stream ended before completion. |
| `AI_UPSTREAM_ERROR` | 502 | The AI provider returned an error. |
| `REQUEST_FAILED` | — | A request failed without a more specific code. |

## Typed SDK errors

| Class | Codes |
|-------|-------|
| `NotAuthenticatedError` | `NOT_AUTHENTICATED` |
| `CapabilityDisabledError` | `CAPABILITY_DISABLED` |
| `NotFoundError` | `NOT_FOUND` |
| `QuotaExceededError` | `QUOTA_EXCEEDED`, `KEY_LIMIT`, `VALUE_TOO_LARGE`, `CONNECTION_LIMIT` |
| `CanvasdropError` | any other code (base class) |
