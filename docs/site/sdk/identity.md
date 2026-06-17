# Identity

Need to know who's looking at your canvas? `canvasdrop.me()` returns the
signed-in viewer. Identity always comes from the server-side session, so the
canvas never sees or handles credentials, and the viewer can't spoof who they are.

```js
const me = await canvasdrop.me();
// { id, email, name, avatarUrl, kind }
//
// {
//   id: "u_abc123",
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
| `kind` | `"member" \| "guest"` | `"member"` for org members, `"guest"` for invited guests. |

Under the hood, `me()` calls `GET {base}/v1/c/{slug}/me` with the session cookie.
No token is ever passed in the page.

## When it's available

Identity has no separate toggle: `me()` is available exactly when **Backend** is
on for the canvas (the Backend tab labels it "Always on"). With Backend off, the
call throws `CapabilityDisabledError` (code `CAPABILITY_DISABLED`, 403).

If the viewer is not signed in, it throws `NotAuthenticatedError` (code
`NOT_AUTHENTICATED`, 401), though in normal use a viewer who reached the canvas
has already been authenticated by the platform.

```js
import { CapabilityDisabledError, NotAuthenticatedError } from "@canvas-drop/sdk";

try {
  const me = await canvasdrop.me();
  greet(me.name);
} catch (err) {
  if (err instanceof CapabilityDisabledError) {
    // Backend is turned off for this canvas
  } else if (err instanceof NotAuthenticatedError) {
    // viewer isn't signed in
  }
}
```

## Scoping per-user data

Use `me().id` to key per-user state, or reach for the
[user KV namespace](/docs/sdk/kv) (`canvasdrop.kv.user`), which scopes every
key to the current viewer automatically, no `id` plumbing required.
