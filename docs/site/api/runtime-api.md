# Runtime API

The runtime API is what the [browser SDK](/docs/sdk/overview) calls from inside a
canvas. Reach for the SDK first — it builds these requests, handles the SSE/WebSocket
wire formats, and maps errors to typed exceptions. Use this reference when you need the
raw routes: debugging, a non-JS client, or to know exactly what a primitive returns.

All routes live under `{base}/v1/c/{slug}`. The path is identical in both URL modes
(`path` and `subdomain`) — only the host the SDK targets changes. The SDK derives
`{base}` from the canvas location, so you never hard-code it.

In a canvas, the SDK is on the page as the global `canvasdrop`:

```js
// served at {base}/sdk/v1.js, exposed as window.canvasdrop
const me = await canvasdrop.me();          // → { id, email, name, avatarUrl, kind }
await canvasdrop.kv.set("greeting", "hi"); // shared KV
```

There is no `cd` alias — the single global is `canvasdrop`.

> **Auth:** every request is credentialed with the **session cookie**, sent
> automatically by the browser. Identity is resolved server-side from that session —
> the canvas never asserts who the viewer is. Unauthenticated requests are stopped
> by the auth gateway before any route runs — a `401` in `proxy`/`dev` mode, or a
> `302` redirect to `/auth/login` in `oidc` mode. (This differs from the Bearer-key
> [Deploy API](/docs/api/deploy-api).)
>
> **Capabilities:** each primitive is gated by its capability (`identity`, `kv`,
> `files`, `ai`, `realtime`). When a capability is off for the canvas or the
> instance, the route returns `403 CAPABILITY_DISABLED`.

## Pipeline errors

Before any handler runs, every `/v1/c/{slug}/*` request passes through resolve +
authorize + isolation + capability checks. These can return before your handler:

| Code | HTTP | When |
|---|---|---|
| `NOT_FOUND` | 404 | Missing slug param, or the resolver denies as not-found (canvas absent, deleted). |
| `ARCHIVED` / `NOT_INVITED` / `OWNER_ONLY` / `SHARE_EXPIRED` | 404 | Other resolver denials, each returned as its own uppercased `code`. |
| `DISABLED` | 403 | The canvas is disabled. |
| `PASSWORD_REQUIRED` | 403 | Password-gated shared canvas, non-owner, gate cookie not satisfied. |
| `STATIC_ONLY` | 403 | A `public_link` canvas accessed by a non-owner or anonymous viewer — the runtime API is fully closed. Body: `{ code, message }`. |
| `CROSS_CANVAS_FORBIDDEN` | 403 | Cross-canvas request: `subdomain` mode with an `Origin` that doesn't match this canvas's origin (a request with no `Origin` is treated as a non-browser caller and passes), or `path` mode with a `Referer` not on this canvas. |
| `CROSS_SITE_FORBIDDEN` | 403 | `path` mode with `Sec-Fetch-Site` not `same-origin`/`none`. |
| `CAPABILITY_DISABLED` | 403 | The route's capability is off. Body: `{ code, capability }`. |

Preflight `OPTIONS /v1/c/{slug}/*` is answered before the auth gateway with `204`,
advertising methods `GET,POST,PUT,DELETE,OPTIONS` and header `Content-Type`. In
`subdomain` mode the runtime API emits credentialed CORS for the canvas's exact
subdomain origin; in `path` mode the canvas is same-origin and no cross-origin CORS
header is sent. The path itself is identical in both modes.

Unauthenticated requests are stopped by the auth gateway before any route runs — a
`401` in `proxy`/`dev` mode, or a `302` redirect to `/auth/login` in `oidc` mode. All
`code` values are stable — see [Error codes](/docs/api/errors).

## Identity

Capability: `identity`. Returns `403 CAPABILITY_DISABLED` when identity is off.

```
GET {base}/v1/c/{slug}/me   → 200 { id, email, name, avatarUrl, kind }
```

`avatarUrl` may be `null`. `kind` is normally `"member"` for the current signed-in
user. `"guest"` is retained only for legacy guest sessions from older instances; new
Add person grants materialize as signed-in users after verified auth. An anonymous
visitor never reaches the runtime API (a `public_link` canvas is static-only and
returns `STATIC_ONLY`). This runtime `me()` deliberately omits `isAdmin`; the
dashboard SPA's `/api/me` is a separate endpoint that includes it.

## Key–value

Capability: `kv`. Two scopes, identical method set:

- **Shared** at `/kv` — readable and writable by every viewer of the canvas.
- **Per-viewer** at `/kv/user` — scope is forced to the caller's server-resolved
  `user.id`, never client-supplied.

```
GET    {base}/v1/c/{slug}/kv?prefix=&cursor=&limit=   list  → { entries, nextCursor }
GET    {base}/v1/c/{slug}/kv/{key}                    read  → { value } (404 if absent)
PUT    {base}/v1/c/{slug}/kv/{key}                    write (JSON body = the value)
DELETE {base}/v1/c/{slug}/kv/{key}                    delete (idempotent, no 404)
POST   {base}/v1/c/{slug}/kv/{key}/increment          atomic add → { value }
```

The same five routes exist under `/kv/user/...` for the per-viewer namespace.
`increment` body is `{ by?: number }` (default `1`) and requires a numeric value.

Limits: value ≤ 64 KiB, key ≤ 512 B, ≤ 10 000 shared keys / ≤ 1 000 user keys
(admin-tunable). Errors: `KEY_TOO_LARGE` (413), `VALUE_TOO_LARGE` (413),
`INVALID_BODY` (400), `KEY_LIMIT` (409), `NOT_NUMERIC` (409, increment on a
non-number).

## Files

Capability: `files`.

```
POST   {base}/v1/c/{slug}/files              upload (multipart, field "file") → 201 { id, name, size, url }
GET    {base}/v1/c/{slug}/files              list → 200 { files: [{ id, name, size, mime, createdAt }] }
GET    {base}/v1/c/{slug}/files/{id}/content download → 200 raw bytes
DELETE {base}/v1/c/{slug}/files/{id}         delete → 200 { ok: true } (404 if absent)
```

Upload returns `url` pointing at the content route (`/v1/c/{slug}/files/{id}/content`).
Content is served with `X-Content-Type-Options: nosniff` and a sanitized filename;
SVGs are forced to `attachment` to neutralize inline scripts. Errors: `INVALID_BODY`
(400, missing/invalid file), `FILE_TOO_LARGE` (413, over the per-file size limit),
and a `409` when the canvas storage quota is exceeded.

## AI

Capability: `ai` — effective only when the canvas's `ai` capability is on **and** an
effective provider key is configured. The provider key is server-side only and never
appears in any response.

```
POST   {base}/v1/c/{slug}/ai/chat            chat completion (SSE stream)
```

Request body:

```json
{
  "model": "<provider model id>",
  "messages": [{ "role": "user", "content": "Hello" }],
  "system": "optional system prompt",
  "maxTokens": 1024
}
```

`messages` needs ≥ 1 entry with roles `user` or `assistant` (the system prompt rides
the `system` field, not a message role). `maxTokens` defaults to 1024, hard max 8192.

Success is an SSE stream (`text/event-stream`): zero or more
`{ type: "delta", text }` events, then a terminal
`{ type: "done", usage: { inputTokens, outputTokens }, cost }`.

Errors are split by when they occur:

- **Pre-stream** (status set before the body): `INVALID_BODY` (400),
  `MODEL_NOT_ALLOWED` (403, model not in the allowlist or allowlisted-but-unpriced),
  `GUEST_AI_DISABLED` (403, a retained legacy guest-session viewer called AI on a
  canvas that has not enabled it for that retained session type), `GUEST_AI_CAP`
  (429, retained legacy guest-session spend cap reached; body
  `{ code, scope: "guest" }`), `QUOTA_EXCEEDED` (429, spend/rate cap; body
  `{ code, scope }`), `CAPABILITY_DISABLED` (403, no effective provider key after the gate).
- **In-stream** (HTTP already 200): an SSE
  `{ type: "error", code: "AI_UPSTREAM_ERROR", message }` event. Usage and quota are
  recorded even if the client aborts mid-stream.

## Realtime

Capability: `realtime`. Available only when the instance has a WebSocket adaptor
wired.

```
WS     {base}/v1/c/{slug}/realtime            channel pub/sub + presence
```

Auth, authorization, password-gate, and Origin are all enforced **before** the
upgrade — a failure refuses the `101` (no socket). The capability check is the one
post-upgrade gate: if `realtime` is off, the server accepts then sends
`{ type: "error", code: "CAPABILITY_DISABLED", capability: "realtime" }` and closes
with code `4403`.

Limits: 30 connections per canvas, 100 messages per minute per user, 16 KiB max
frame. Close codes after the socket is open: `4401` (the session lost access on
revalidation — canvas gone, access revoked, became static-only, password gate, or
user deactivated), `4403` (`realtime` capability disabled), `4429` (connection limit
reached).

The frame protocol — client frames `publish`, `subscribe`, `unsubscribe`,
`presence`, and the `subscribed` / `message` / `presence` / `join` / `leave` frames
the server sends back — is managed by the realtime hub. The server resolves sender
identity (`from`) itself; the client cannot spoof it. In-band error frames carry a
`code`: `RATE_LIMITED`, `MESSAGE_TOO_LARGE`, `INVALID_FRAME`, `UNKNOWN_FRAME`. Use
the SDK's `realtime.channel(name)` API rather than driving the socket by hand; it
handles framing, reconnection, and presence for you. See the
[SDK reference](/docs/sdk/overview).

## Adjacent endpoints

These are part of the client surface but not under `/v1/c/{slug}`:

```
GET {base}/api/me      dashboard SPA identity → { id, email, name, avatarUrl, isAdmin, canPublishPublic, authMode, urlMode, baseUrl }
GET {base}/sdk/v1.js   the served browser SDK bundle (503 if not built)
```

`/api/me` sits behind the session gateway but is **not** capability-gated, and unlike
the runtime `me()` it adds `isAdmin`, `canPublishPublic`, and the instance config
`authMode` (`proxy` | `oidc` | `dev`), `urlMode` (`path` | `subdomain`), and `baseUrl`
— config, not user data. `/sdk/v1.js` is served behind the auth gateway as
`application/javascript` with `cache-control: public, max-age=3600` (`503` plain text
when no built bundle is available).

## Errors

All endpoints return stable `code` values — see [Error codes](/docs/api/errors).
