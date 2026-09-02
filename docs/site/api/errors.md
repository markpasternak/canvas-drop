# Error codes

If you call the Runtime API or the browser SDK from a canvas, or you are an agent
handling its failures, this page is the contract. Branch on the error's `code`,
never on its message text. Every refusal from `/v1/c/{slug}/*` is JSON with a
stable `code` and an HTTP status, and the browser SDK throws typed errors that
extend `CanvasdropError`, each with a readonly `.code` and `.status` (plus `.hint`
when the server sent a remediation hint).

The browser global is `window.canvasdrop`, loaded from `{base}/sdk/v1.js`; there
is no `cd` alias. The error classes, `ERROR_CODES`, and `errorFromResponse` are
named exports of `@canvas-drop/sdk` for code that imports the package.

```js
try {
  await canvasdrop.kv.set("prefs", { theme: "dark" });
} catch (err) {
  switch (err.code) {
    case "CAPABILITY_DISABLED": // KV is off for this canvas; the hint says how to turn it on
      showBanner(err.hint);
      break;
    case "VALUE_TOO_LARGE":
    case "KEY_LIMIT":
      showBanner("Storage limit reached.");
      break;
    default:
      throw err;
  }
}
```

`kv.get` returns `null` for a missing key instead of throwing, so most reads need
no `try/catch`.

## The codes

Codes, statuses, and meanings below are the SDK's exported `ERROR_CODES`, in the
same order (each entry is `{ status, summary }`; `ErrorCode` is its key type).

| Code | Status | Meaning |
|------|--------|---------|
| `NOT_AUTHENTICATED` | 401 | The viewer is not signed in. |
| `PASSWORD_REQUIRED` | 403 | The canvas is password-protected. |
| `CAPABILITY_DISABLED` | 403 | Backend or the specific feature is off for this canvas. |
| `CROSS_CANVAS_FORBIDDEN` | 403 | A request targeted another canvas's resources. |
| `MODEL_NOT_ALLOWED` | 403 | The requested AI model is not in the allow-list. |
| `DISABLED` | 403 | The canvas has been disabled by an administrator. |
| `STATIC_ONLY` | 403 | The canvas is a public link (`public_link`): every backend primitive is refused for non-owners. |
| `GUEST_AI_DISABLED` | 403 | AI is not enabled for a retained legacy guest-session viewer. |
| `GUEST_AI_CAP` | 429 | The canvas reached its retained legacy guest-session AI spend cap. |
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
| `PUBLISH_FAILED` | 502 | `canvasdrop.canvases.publish` created the canvas but its deploy or share-config failed; the new canvas's id is returned so the caller can retry or revoke. |
| `SHARE_REVOKED` | 409 | `canvasdrop.canvases.update` was called on an unpublished share without a bundle; include a bundle to publish it again. |
| `REQUEST_FAILED` | 0 | A request failed without a more specific code. |

Five rows need a note:

- `NOT_AUTHENTICATED` is what the SDK throws for **any** 401. The auth gateway's
  own 401 (in `dev` and `proxy` modes) has the shape `{ "error": "unauthorized" }`
  with no `code`; the SDK normalizes it. In `oidc` mode the gateway does not
  return 401 at all: a signed-out request is redirected (302) to the login page.
  The authoring routes return `401 { "code": "NOT_AUTHENTICATED" }` to a retained
  legacy guest session, since only org members can author.
- `STATIC_ONLY` applies to every caller except the canvas's owner and its
  editors. A signed-in member gets it on a Public link canvas too, not only an
  anonymous visitor.
- `QUOTA_EXCEEDED` is 429 from AI (the body adds `scope`: `user_daily` or
  `canvas_monthly`) and from authoring (`scope`: `user_daily` or `user_total`),
  but **409** when a file upload would exceed the per-canvas byte quota.
  `err.code` is the same in all three cases; `err.status` and `scope` tell them
  apart.
- `INVALID_BODY` is 400 everywhere except one case: an authoring bundle over
  50 MiB returns `413 { "code": "INVALID_BODY", "message": "bundle too large" }`,
  and the SDK's any-413 rule puts it on `QuotaExceededError` (see below).
- `REQUEST_FAILED` is the SDK's fallback when a response carries no `code`. The
  `0` is nominal; `err.status` holds the real HTTP status.

> **`CAPABILITY_DISABLED` is self-repairing.** Its 403 body carries extra fields
> beyond `code`, so a caller (or an agent) can fix it without guessing:
> `capability` (which one), `backendEnabled` (the master switch, `false` on a new
> canvas), `reason` (`backend_off`, `feature_off`, or `operator_disabled`), and a
> human-readable `hint`. The SDK puts the hint on the thrown
> `CapabilityDisabledError` as both its message and `.hint`. For `backend_off` and
> `feature_off` the fix is the owner's or an editor's: the canvas's **Backend** tab,
> the `set_capabilities` MCP tool, or
> `PATCH /api/canvases/{id}/capabilities {"backendEnabled": true, "kv": true}`.
> `operator_disabled` (AI, realtime, and authoring only) is a deployment-level
> setting: no AI provider key, `CANVAS_DROP_REALTIME=off`, or
> `CANVAS_DROP_AUTHORING=off` (the default). See
> [Capabilities](/docs/authoring/capabilities).

> **`DISABLED` has two surfaces.** On the Runtime API (viewers, the browser SDK) a
> canvas an admin has taken down returns `DISABLED` with status **403**, the row
> above. On the owner management API (`/api/canvases/{id}/...`), the authoring
> routes' `PUT`/`DELETE`, and over MCP, the same takedown makes the canvas
> read-only to its owner and editors: reads succeed, but every mutation (settings,
> sharing, tags, capabilities, slug, preview, deploy, publish, rollback, archive,
> unpublish, draft edits) is refused with HTTP **409**
> `{ "code": "DISABLED", "message": "This canvas has been disabled by an administrator." }`,
> with ` Reason: <text>` appended when the admin set one. The MCP tool result is
> `DISABLED: <that message>`. The same management surfaces refuse an editor's
> owner-only act (delete, transfer, the guest-AI opt-in) with **403**
> `{ "code": "OWNER_ONLY", "message": "Only the canvas owner can do this." }`; do
> not confuse it with the Runtime API's `OWNER_ONLY`, which is a 404 (next section).

## Typed SDK errors

The SDK exports the base class and five subclasses. Any code without a dedicated
subclass is thrown as the base `CanvasdropError` with `.code` set from the
response.

| Class | `.code` | `.status` | Extra |
|-------|---------|-----------|-------|
| `NotAuthenticatedError` | `NOT_AUTHENTICATED` | 401 | |
| `CapabilityDisabledError` | `CAPABILITY_DISABLED` | 403 | message and `.hint` from the server's `hint`; no `.capability` property |
| `NotFoundError` | `NOT_FOUND` | 404 | |
| `QuotaExceededError` | `QUOTA_EXCEEDED` by default; see below | 429 by default; see below | message is always `quota exceeded` |
| `PublishFailedError` | `PUBLISH_FAILED` | 502 | `.id`: the created canvas's id, when the failure happened after creation |
| `CanvasdropError` (base) | any | any | `.hint` when the server sent one |

The SDK picks the class from the HTTP response in this order (`errorFromResponse`):

1. Status 401 → `NotAuthenticatedError` (any body `code` is ignored).
2. Status 403 with `code: "CAPABILITY_DISABLED"` → `CapabilityDisabledError`.
3. Status 404 → `NotFoundError` (any body `code` is ignored; see the next section).
4. `code: "PUBLISH_FAILED"` → `PublishFailedError` with `.id` from the body.
5. `code` of `QUOTA_EXCEEDED`, `GUEST_AI_CAP`, or `KEY_LIMIT`, or **any 413** →
   `QuotaExceededError`, keeping the body's `code` and the response's status.
6. Anything else → `CanvasdropError` with the body's `code` (or `REQUEST_FAILED`),
   the response status, and the body's `hint` or `message` as the message.

So `QuotaExceededError` is the one limit-shaped class and it is reused: expect
`.code` values of `QUOTA_EXCEEDED`, `GUEST_AI_CAP`, `KEY_LIMIT` (409),
`KEY_TOO_LARGE`, `VALUE_TOO_LARGE`, `FILE_TOO_LARGE`, `BODY_TOO_LARGE`,
`INVALID_BODY` (413), and, from realtime, `CONNECTION_LIMIT` (429). `NOT_NUMERIC`
is a 409 but not a limit, so it stays on the base class. Never assume a
`QuotaExceededError` is literally `QUOTA_EXCEEDED`; read `err.code`.

Classes such as `PasswordRequiredError`, `ModelNotAllowedError`, or
`CrossCanvasForbiddenError` do not exist. `PASSWORD_REQUIRED`, `STATIC_ONLY`,
`DISABLED`, `MODEL_NOT_ALLOWED`, `CROSS_CANVAS_FORBIDDEN`, `GUEST_AI_DISABLED`,
`INVALID_BODY` (at 400), `NOT_NUMERIC`, `SHARE_REVOKED`, and `AI_UPSTREAM_ERROR`
all arrive on the base `CanvasdropError`. Branching on `err.code` is the only
reliable check.

## Server codes outside the enum

The Runtime API can return a few codes that are not in `ERROR_CODES`. They are
stable; the table shows how each reaches SDK callers.

| Code | Status | When | In the SDK |
|------|--------|------|------------|
| `RATE_LIMITED` | 429 | A request bucket is spent. Primitives: per user per canvas, default 120/min. `.../ai/*`: per user across all canvases, default 10/min. Headers: `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. | `CanvasdropError`, `code: "RATE_LIMITED"` |
| `ARCHIVED`, `NOT_INVITED`, `OWNER_ONLY`, `SHARE_EXPIRED` | 404 | The canvas resolved but access was denied (archived; guest scoped to another canvas; not on the sharing rung, including a non-owner admin; share expired). | `NotFoundError`, `code: "NOT_FOUND"`; the body's code is not preserved |
| `CROSS_SITE_FORBIDDEN` | 403 | Path mode only: `Sec-Fetch-Site` is present and not `same-origin` or `none`. | `CanvasdropError` |
| `BODY_TOO_LARGE` | 413 | `POST .../ai/chat` body over 256 KiB. | `QuotaExceededError`, `code: "BODY_TOO_LARGE"` (every 413 maps there) |
| `ORG_REQUIRED`, `SLUG_TAKEN` | 409 | Authoring publish/update. | `CanvasdropError` |
| `PUBLIC_LINKS_DISABLED`, `PUBLIC_NOT_ALLOWED`, `PUBLIC_LINK_OWNER_GATED` | 403 | Authoring publish/update asked for a Public link the instance, the actor, or the actor's role (editor) cannot grant. | `CanvasdropError` |

The full per-route list, including which routes emit `INVALID_BODY` with a
`reason` field, is on the [Runtime API](/docs/api/runtime-api) page.

## Client-side codes

The SDK also throws a handful of codes that never come from the server. They are
base `CanvasdropError`s and are not in `ERROR_CODES`, so `err.code` is typed
`string`, not `ErrorCode`.

| Code | Status | When |
|------|--------|------|
| `NO_STREAM` | the HTTP status | The AI response had no body. |
| `MALFORMED_FRAME` | 502 | An SSE `data:` line was not valid JSON (proxy teardown, partial flush). |
| `AI_ERROR` | 502 | An in-stream `error` frame arrived without a string `code`. |
| `DISCONNECTED` | 0 | The realtime socket dropped while a `presence()` call was in flight; the SDK is reconnecting, retry the call. |
| `CHANNEL_CLOSED` | 0 | `publish()` or `presence()` was called on a channel after `close()`; pending `presence()` calls also reject with it when `close()` runs. |

## AI stream errors

`ai.chat` and `ai.stream` consume a server-sent event stream. Failures surface in
two ways:

- **Before the stream starts**, as an HTTP error mapped per the tables above, in
  the server's check order: `BODY_TOO_LARGE` (413), `INVALID_BODY` (400),
  `MODEL_NOT_ALLOWED` (403), `GUEST_AI_DISABLED` (403), `GUEST_AI_CAP` (429),
  `QUOTA_EXCEEDED` (429), or `CAPABILITY_DISABLED` (403). `RATE_LIMITED` (429)
  fires before any of them.
- **Mid-stream**, as an `error` frame. `CAPABILITY_DISABLED` becomes
  `CapabilityDisabledError`; `QUOTA_EXCEEDED` and `GUEST_AI_CAP` become
  `QuotaExceededError` with status 429; any other code becomes a base
  `CanvasdropError` with that code and status 502. The server's mid-stream
  provider failure is `AI_UPSTREAM_ERROR`; a frame with no code defaults to
  `AI_ERROR`.

If the stream ends without a terminal `done` or `error` frame, both methods
throw `AI_STREAM_TRUNCATED` (502). `ai.stream` yields text only; usage and cost
are available from `ai.chat`.

## Realtime close codes

A terminal WebSocket close maps to a typed error and stops reconnecting. Any
pending `presence()` call rejects with it, and later `publish()` or `presence()`
calls on the same client throw it.

| Close code | Error |
|------------|-------|
| `4403` | `CapabilityDisabledError` (`realtime` is off) |
| `4401` | `NotAuthenticatedError` (access lost, canvas gone, canvas turned Public link, password gate newly set, or user inactive) |
| `4429` | `QuotaExceededError` (`code: "CONNECTION_LIMIT"`, status 429; 30 connections per canvas) |

An in-band `{ "type": "error", "code": "CAPABILITY_DISABLED" }` frame is terminal
in the same way. The hub's other error frames (`MESSAGE_TOO_LARGE`,
`INVALID_FRAME`, `CHANNEL_NAME_TOO_LARGE`, `CHANNEL_LIMIT`, `RATE_LIMITED`,
`UNKNOWN_FRAME`) are dropped by the SDK; there is no hook to observe them, so a
rejected publish is silent. Stay inside the limits on the
[Runtime API](/docs/api/runtime-api#realtime) page.

Any other close is transient: the SDK reconnects with exponential backoff (500 ms
doubling to a 10 s cap), re-subscribes every channel, and flushes up to 256
buffered frames. An in-flight `presence()` call rejects with `DISCONNECTED`
(status 0) so the caller can retry.
