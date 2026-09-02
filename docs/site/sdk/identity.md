# Identity

Know who is looking at your canvas. This page is the reference for
`canvasdrop.me()`, the identity primitive on the `canvasdrop` global that
`<script src="/sdk/v1.js">` defines in every canvas. `me()` returns the
signed-in viewer, resolved from the server-side session: the page never handles
a token, and a viewer cannot claim to be someone else. By the end you can greet
the viewer by name, key shared data per person, and handle every error `me()`
returns.

The canvas needs **Enable backend** on in its **Backend** tab. Identity has no
toggle of its own: it is available whenever the backend is on (see
[Capabilities](/docs/authoring/capabilities)).

```js
const me = await canvasdrop.me();
// {
//   id: "0190a3f2-7c4e-7a1b-9d2f-3c5e6a7b8c9d",
//   email: "someone@example.com",
//   name: "Alex Rivera",
//   avatarUrl: null,
//   kind: "member"
// }
document.querySelector("#greeting").textContent = `Hi, ${me.name}`;
```

Call it once per page load and keep the result. The runtime API is rate-limited
per viewer per canvas (120 requests a minute by default, one budget shared by
`me()`, `kv`, and `files`; `ai` has its own), so a `me()` on every render spends
budget for nothing.

## Signature

```ts
me(): Promise<Me>

interface Me {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  kind: "member" | "guest";
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Stable per-user id. Key per-user data on this, never on `email`. |
| `email` | `string` | The viewer's email. |
| `name` | `string` | Display name. |
| `avatarUrl` | `string \| null` | Avatar URL, or `null` when the identity provider gives none. |
| `kind` | `"member" \| "guest"` | `"member"` for a signed-in org user. `"guest"` is retained only for legacy guest sessions; see below. There is no `"anonymous"`: a signed-out visitor never reaches the runtime API. |

The projection is deliberately minimal. It carries no admin flag and no org
membership, so canvas code cannot tell an admin from any other member. That
information stays on the dashboard side.

## Where the identity comes from

`me()` calls `GET {base}/v1/c/{slug}/me` with the viewer's session cookie
(`credentials: "include"`). The SDK works out the slug and the API origin from
`window.location`; there is nothing to configure.

| URL mode | Canvas page | `me()` request |
| --- | --- | --- |
| `path` | `{base}/c/{slug}/` | `{base}/v1/c/{slug}/me` (same origin) |
| `subdomain` | `https://{slug}.canvases.example.com/` | `https://canvases.example.com/v1/c/{slug}/me` (the base host, with credentialed CORS) |

The server resolves the user from the session and returns the projection above.
Nothing in the page identifies the viewer, so nothing in the page can be edited
to impersonate someone.

The same server-side `id` is what scopes the [per-viewer KV
namespace](/docs/sdk/kv) (`canvasdrop.kv.user`) and what appears as `from.id`
on [realtime](/docs/sdk/realtime) messages and in presence lists. You never pass
it; the server already knows it.

### Legacy guest sessions

People you add under **People and teams with direct access** sign in through the org's normal
login and arrive as `"member"`, so on a current instance that is the only
`kind` you will see. `"guest"` remains for guest sessions retained from older
instances. A guest's `id` is namespaced `guest:<inviteId>` so it never collides
with an org user id; its `name` is its email and its `avatarUrl` is `null`.
Guests hold no org capabilities, and AI for guests has its own per-canvas switch
(see [AI](/docs/sdk/ai)).

## Errors

`me()` rejects with a `CanvasdropError` (or a subclass); branch on `err.code`.
The codes you will actually meet:

| Code | Status | When |
| --- | --- | --- |
| `CAPABILITY_DISABLED` | 403 | The canvas's backend is off. `err.hint` names the switch: the dashboard Backend tab, the `set_capabilities` MCP tool, or `PATCH /api/canvases/:id/capabilities`. Thrown as `CapabilityDisabledError`. |
| `STATIC_ONLY` | 403 | The canvas is at the Public link rung. Every backend primitive, `me()` included, is refused for anyone who is not the owner or an editor, signed in or not. |
| `RATE_LIMITED` | 429 | Too many runtime-API calls from this viewer on this canvas within the last minute. Back off and retry. A plain `CanvasdropError`, not a `QuotaExceededError`. |
| `NOT_AUTHENTICATED` | 401 | No session. Rare in practice: a viewer who reached the canvas has already signed in. In `proxy` and `dev` auth modes the gateway answers 401; in `oidc` mode it redirects to login instead. Thrown as `NotAuthenticatedError`. |

Access is re-checked on every call, so `me()` can also fail later in a session
when the viewer's access changed after the page loaded: `PASSWORD_REQUIRED`
(403) when the password gate must be passed again, `DISABLED` (403) when an
admin disabled the canvas, and a `NotFoundError` (404) when the share expired or
was revoked or the canvas was archived. A page reload sends the viewer back
through the normal entry flow.

```js
try {
  const me = await canvasdrop.me();
  greet(me.name);
} catch (err) {
  if (err.code === "CAPABILITY_DISABLED") {
    // backend is off for this canvas; err.hint says what to switch on
  } else if (err.code === "STATIC_ONLY") {
    // public-link canvas: static for everyone but the owner and editors
  } else {
    throw err;
  }
}
```

The error classes are also exported by `@canvas-drop/sdk` for `instanceof`
checks; the [error codes reference](/docs/api/errors) lists every code.

## Per-user data without plumbing

Most canvases do not need `me().id` at all. `canvasdrop.kv.user` scopes every
key to the current viewer on the server, so per-person state is
`await canvasdrop.kv.user.set("draft", text)` with no id in sight. Reach for
`me()` when you want to show the viewer's name or avatar, or when the shared
namespace needs a per-user key (`votes:${me.id}`) that other viewers can read.
