# Runtime API

The runtime API is what the [browser SDK](/docs/sdk/overview) calls from inside a
canvas. Reach for the SDK first — it builds these requests, handles the SSE/WebSocket
wire formats, and maps errors to typed exceptions. Use this reference when you need the
raw routes: debugging, a non-JS client, or to know exactly what a primitive returns.

All routes live under `{base}/v1/c/{slug}`. The path is identical in both URL modes
(`path` and `subdomain`) — only the host the SDK targets changes. The SDK derives
`{base}` from the canvas location, so you never hard-code it.

> **Auth:** every request is credentialed with the **session cookie**, sent
> automatically by the browser. Identity is resolved server-side from that session —
> the canvas never asserts who the viewer is. Unauthenticated requests get `401`
> before any route runs. (This differs from the Bearer-key
> [Deploy API](/docs/api/deploy-api).)
>
> **Capabilities:** each primitive is gated by its capability (`identity`, `kv`,
> `files`, `ai`, `realtime`). When a capability is off for the canvas or the
> instance, the route returns `403 CAPABILITY_DISABLED`.

## Pipeline errors

Before any handler runs, every `/v1/c/{slug}/*` request passes through resolve +
authorize + isolation. These can return before your handler:

| Code | HTTP | When |
|---|---|---|
| `401` | 401 | Not signed in (auth gateway, no body). |
| `NOT_FOUND` | 404 | Missing or unknown canvas slug. |
| `PASSWORD_REQUIRED` | 403 | Password-gated shared canvas, no valid grant. |
| `CROSS_CANVAS_FORBIDDEN` | 403 | Request origin/referrer targets another canvas. |
| `CROSS_SITE_FORBIDDEN` | 403 | Disallowed cross-site origin (subdomain mode). |
| `CAPABILITY_DISABLED` | 403 | The route's capability is off. Body: `{ code, capability }`. |

Subdomain mode additionally enforces Origin-matches-slug and emits credentialed
CORS (the `CROSS_*` errors); path mode is same-origin. All `code` values are stable
— see [Error codes](/docs/api/errors).

## Identity

Capability: `identity` — it has no separate toggle and is effective exactly when
the canvas's **Backend** is on.

```
GET {base}/v1/c/{slug}/me   → 200 { id, email, name, avatarUrl }
```

`avatarUrl` may be `null`. This runtime `me()` deliberately omits `isAdmin`; the
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
`QUOTA_EXCEEDED` (409, canvas storage quota).

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
  `MODEL_NOT_ALLOWED` (403, model not in the allowlist or unpriced),
  `QUOTA_EXCEEDED` (429, per-user daily or per-canvas monthly USD cap; body
  `{ code, scope }`), `CAPABILITY_DISABLED` (403).
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

**Client → server frames** (JSON, ≤ 16 KiB):

| `type` | Fields | Effect |
|---|---|---|
| `subscribe` | `channel` | Join a channel. |
| `unsubscribe` | `channel` | Leave a channel. |
| `publish` | `channel`, `event`, `data` | Broadcast to the channel (server attaches `from` from server-side identity). |
| `presence` | `channel` | Request the current presence list. |

**Server → client frames:** `subscribed`, `presence`
(`{ channel, users: [{ id, name }] }`), `join` / `leave`
(`{ channel, user: { id, name } }`), `message`
(`{ channel, event, data, from: { id, name } }`), and `error`
(`{ code, message }`, codes `MESSAGE_TOO_LARGE`, `INVALID_FRAME`, `UNKNOWN_FRAME`,
`RATE_LIMITED`).

**Close codes:** `4401` unauthorized, `4403` capability disabled, `4429` connection
limit. The server can drop a live socket with `4401`/`4403` when access, capability,
password, or user-active state changes. Limits: 30 connections per canvas, 100
messages/min, 16 KiB per frame.

## Adjacent endpoints

These are part of the client surface but not under `/v1/c/{slug}`:

```
GET {base}/api/me      dashboard SPA identity → { id, email, name, avatarUrl, isAdmin, authMode }
GET {base}/sdk/v1.js   the served browser SDK bundle (503 if not built)
```

`/api/me` sits behind the auth gateway but is **not** capability-gated, and unlike
the runtime `me()` it includes `isAdmin` and the instance `authMode`. `/sdk/v1.js` is
served `application/javascript; charset=utf-8` with `cache-control: public,
max-age=3600`.

## Errors

All endpoints return stable `code` values — see [Error codes](/docs/api/errors).
