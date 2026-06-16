# Identity

`canvasdrop.me()` returns the signed-in viewer. Identity comes from the
server-side session — the canvas never sees or handles credentials.

```js
const me = await canvasdrop.me();
// { id, email, name, avatarUrl, kind }
```

| Field | Notes |
|-------|-------|
| `id` | Stable per-user id. Use this as a key, not the email. |
| `email` | The viewer's email. |
| `name` | Display name. |
| `avatarUrl` | Avatar URL, or `null` when the provider gives none. |
| `kind` | `"member"` for org members, `"guest"` for invited guests. |

`me()` calls `GET /v1/c/<slug>/me` with the session cookie (`credentials: include`);
no token is ever passed in the page.

Identity has no separate toggle: `me()` is available exactly when **Backend** is
on for the canvas. With Backend off, the call throws `CapabilityDisabledError`
(code `CAPABILITY_DISABLED`). If the viewer is not signed in, it throws
`NotAuthenticatedError` (code `NOT_AUTHENTICATED`) — though in normal use a viewer
who reached the canvas has already been authenticated by the platform.

Use `me().id` to scope per-user data — or just use the
[user KV namespace](/docs/sdk/kv) (`canvasdrop.kv.user`), which scopes to the
viewer automatically.
