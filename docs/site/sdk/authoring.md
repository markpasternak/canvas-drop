# Authoring

Let a signed-in viewer of your canvas create a **new** canvas from the page — as
themselves, with real ownership and no secret in the browser. The `canvasdrop.canvases`
namespace wraps one high-level `publish` plus `list` and `revoke`.

This is the **authoring** capability. It is off by default and higher-privilege
than the other primitives: the owner turns it on in the **Backend** tab *and* the
operator must enable it for the instance. Guests and public-link visitors can't
use it — creation needs a signed-in org member.

```js
const { id, url } = await canvasdrop.canvases.publish({
  title: "Team roadmap — Q3 snapshot",
  access: "public_link",           // "private" | "specific_people" | "public_link" | "password"
  tags: ["roadmap"],
  expiresAt: Date.now() + 7 * 864e5, // optional; the operator may require/limit it
  bundle: zipBlob,                  // a static-site zip (Blob or ArrayBuffer)
});
// `url` is the live canvas; it now appears in the viewer's own dashboard.

const mine = await canvasdrop.canvases.list();   // what this viewer authored
await canvasdrop.canvases.revoke(id);            // delete/unpublish one of them
```

## Methods

| Method | Returns |
| --- | --- |
| `publish(options)` | `Promise<{ id, url }>` — creates, deploys, and configures a new canvas |
| `list()` | `Promise<AuthoredCanvas[]>` — `{ id, url, title, tags, expiresAt }`, viewer-scoped |
| `revoke(id)` | `Promise<void>` — delete/unpublish one of the viewer's own authored canvases |

### `publish` options

| Field | Type | Notes |
| --- | --- | --- |
| `title` | `string` | required |
| `bundle` | `Blob \| ArrayBuffer` | required — the static-site **zip** |
| `slug` | `string?` | omit for a readable-random slug |
| `tags` | `string[]?` | |
| `access` | `"private" \| "specific_people" \| "public_link" \| "password"?` | operator restricts the allowed set; `"password"` = a public link protected by `password` |
| `password` | `string?` | required when `access` is `"password"` |
| `expiresAt` | `number?` | unix ms; the operator may require an expiry and cap how far out it may be |

`publish` sends one `multipart/form-data` request (`credentials: "include"`): a JSON
`metadata` part plus the zip `bundle` part. It is atomic from your side — the server
creates the canvas, deploys the bundle, and applies the share settings, then returns
a single result.

## Ownership, quotas, and cleanup

- The new canvas is owned by the **viewer** who called `publish`. It counts against
  their normal canvas ownership **and** a per-viewer authoring quota (a daily and an
  all-time cap the operator sets).
- Quota is consumed the moment the canvas is **created** — a `PublishFailedError`
  (deploy/config failed after creation) still counts, since the canvas exists. `revoke`
  removes the canvas but does **not** refund quota.
- `revoke` only affects the viewer's own authored canvases (or an admin's).
- `expiresAt` uses the same share-expiry mechanism as the dashboard, so it only means
  something on a shareable rung (`public_link` / `password` / `specific_people`).

## Errors

Every method rejects with a `CanvasdropError` subclass — catch the one you care about,
or read `err.code` / `err.status`.

- Not a signed-in member (a guest / public visitor) → `NotAuthenticatedError`
  (`status: 401`, `code: "NOT_AUTHENTICATED"`).
- Authoring off (backend off, the per-canvas toggle off, or the operator switch off) →
  `CapabilityDisabledError` (`status: 403`, `code: "CAPABILITY_DISABLED"`).
- Per-viewer daily or all-time cap hit → `QuotaExceededError` (`status: 429`,
  `code: "QUOTA_EXCEEDED"`, with a `scope` of `user_daily` or `user_total`).
- Invalid request (bundle too large, a disallowed access rung, a missing/over-max
  expiry) → `CanvasdropError` (`status: 400`/`413`, `code: "INVALID_BODY"`).
- The canvas was created but its deploy or share-config failed →
  `PublishFailedError` (`status: 502`, `code: "PUBLISH_FAILED"`). Its `.id` is the new
  canvas's id, so you can retry the publish or `canvasdrop.canvases.revoke(id)`.

See [error codes](/docs/api/errors). The underlying HTTP endpoints live under
`/v1/c/<slug>/authoring` — see the [Runtime API](/docs/api/runtime-api).
