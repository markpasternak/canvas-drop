# Identity

Need to know who's looking at your canvas? `canvasdrop.me()` returns the
signed-in viewer. Identity always comes from the server-side session, so the
canvas never sees or handles credentials, and the viewer can't spoof who they are.

```js
const me = await canvasdrop.me();
// { id, email, name, avatarUrl, kind }
//
// {
//   id: "0190a3f2-7c4e-7a1b-9d2f-3c5e6a7b8c9d",
//   email: "alex@example.com",
//   name: "Alex Rivera",
//   avatarUrl: null,
//   kind: "member"
// }
```

## Fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | Stable per-user id. Use this as a key, not the email. |
| `email` | `string` | The viewer's email. |
| `name` | `string` | Display name. |
| `avatarUrl` | `string \| null` | Avatar URL, or `null` when the provider gives none. |
| `kind` | `"member" \| "guest"` | `"member"` for the current signed-in user. `"guest"` is retained only for legacy guest sessions from older instances; new Add person grants materialize as signed-in users after verified auth. |

Under the hood, `me()` calls `GET {base}/v1/c/{slug}/me` with the session cookie.
No token is ever passed in the page.

## Errors

`me()` is gated by the `identity` capability. When `identity` is off for the
canvas, the call throws `CapabilityDisabledError` (code `CAPABILITY_DISABLED`,
403).

If the viewer is not signed in, it throws `NotAuthenticatedError` (code
`NOT_AUTHENTICATED`, 401), though in normal use a viewer who reached the canvas
has already been authenticated by the platform.

The bundle exposes the SDK as `window.canvasdrop`. Catch by `err.code` (no import
needed), or import the error classes from `@canvas-drop/sdk` for `instanceof`:

```js
try {
  const me = await canvasdrop.me();
  greet(me.name);
} catch (err) {
  if (err.code === "CAPABILITY_DISABLED") {
    // identity is turned off for this canvas
  } else if (err.code === "NOT_AUTHENTICATED") {
    // viewer isn't signed in
  }
}
```

## Scoping per-user data

Use `me().id` to key per-user state, or reach for the
[user KV namespace](/docs/sdk/kv) (`canvasdrop.kv.user`), which scopes every
key to the current viewer automatically, no `id` plumbing required.
