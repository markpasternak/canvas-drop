# Identity

`canvasdrop.me()` returns the signed-in viewer. Identity comes from the
server-side session — the canvas never handles credentials.

```js
const me = await canvasdrop.me(); // { id, email, name, avatarUrl }
```

| Field | Notes |
|-------|-------|
| `id` | Stable per-user id. Use this as a key, not the email. |
| `email` | The viewer's email. |
| `name` | Display name (may be empty for some providers). |
| `avatarUrl` | Avatar URL, or `null` when the provider gives none. |

Identity is effective whenever **Backend** is on for the canvas. If the viewer is
not signed in, `me()` throws `NotAuthenticatedError` — though in normal use a
viewer reaching a canvas has already been authenticated by the platform.

Use `me().id` to scope per-user data — or just use the
[user KV namespace](/docs/sdk/kv), which scopes automatically.
