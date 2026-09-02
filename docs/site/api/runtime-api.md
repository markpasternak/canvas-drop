# Runtime API

The runtime API is the HTTP surface a canvas calls from the browser. The
[browser SDK](/docs/sdk/overview) (`window.canvasdrop`, served at `{base}/sdk/v1.js`)
builds every one of these requests, speaks the SSE and WebSocket wire formats, and maps
errors to typed exceptions, so reach for it first. Use this page when you need the raw
routes: reading the network tab, a non-JS client, or the exact shape a primitive returns.

Every route lives under `{base}/v1/c/{slug}`. Requests are credentialed with the session
cookie the browser already holds; identity is resolved server-side from that session and
the canvas never asserts who the viewer is. The five primitives (KV, files, AI, identity,
realtime) plus authoring each sit behind their own capability switch.

```js
// Inside a canvas served in path mode at http://localhost:PORT/c/quiet-otter-x7k2/
const api = "/v1/c/quiet-otter-x7k2";

await fetch(`${api}/kv/greeting`, {
  method: "PUT",
  credentials: "include",
  headers: { "content-type": "application/json" },
  body: JSON.stringify("hi"),                  // the body is the value itself
});
const { value } = await (await fetch(`${api}/kv/greeting`, { credentials: "include" })).json();

// The same two calls through the SDK:
await canvasdrop.kv.set("greeting", "hi");
await canvasdrop.kv.get("greeting");            // → "hi"
```

## Where the API lives

| URL mode | Canvas content | Runtime API |
|---|---|---|
| `path` | `{base}/c/{slug}/` | Same origin: `{base}/v1/c/{slug}/...` |
| `subdomain` | `https://{slug}.canvases.example.com/` | The base host: `https://canvases.example.com/v1/c/{slug}/...` |

The route path is identical in both modes; only the host changes. The SDK derives it from
`location`: in `path` mode it uses `location.origin`; in `subdomain` mode it strips the
first hostname label and keeps the port. Every request goes out with
`credentials: "include"`. `CANVAS_DROP_API_BASE_URL` applies to the Bearer-key
[Deploy API](/docs/api/deploy-api) (`/v1/canvases/...`), not to this surface.

## Before a handler runs

Every `/v1/c/{slug}/*` request passes the same pipeline, in this order. Any route on this
page can return these.

**1. Auth gateway.** No session: `401 {"error":"unauthorized"}` in `proxy` and `dev`
mode, or a `302` to `/auth/login` in `oidc` mode. One exception: an anonymous visitor to
an active, unexpired Public link canvas is let through as an anonymous principal, then
refused with `STATIC_ONLY` in step 3.

**2. Rate limit.** `429 {"code":"RATE_LIMITED"}` with `Retry-After` and
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. Two classes: `canvas`
for everything under `/v1/c/{slug}`, keyed per user per canvas (default 120/min,
`CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN`), and `ai` for `/v1/c/{slug}/ai/*`, keyed per
user (default 10/min, `CANVAS_DROP_RATELIMIT_AI_PER_MIN`).
`CANVAS_DROP_RATELIMIT_ENABLED=false` skips this step.

**3. Resolve and authorize.** The canvas is looked up by slug and the viewer is checked
against its sharing rung. The owner and editors bypass both the rung and the password
gate.

| Code | HTTP | When |
|---|---|---|
| `NOT_FOUND` | 404 | Unknown slug, or the canvas is deleted. |
| `ARCHIVED` | 404 | The canvas is archived. |
| `DISABLED` | 403 | An admin disabled the canvas. |
| `OWNER_ONLY` | 404 | The viewer does not meet the rung: Private, a Team they are not on, Whole org as a non-member, Specific people without a grant, or Public link while public links are switched off for the instance. |
| `SHARE_EXPIRED` | 404 | The share's expiry has passed. |
| `NOT_INVITED` | 404 | A guest principal scoped to a different canvas. |
| `PASSWORD_REQUIRED` | 403 | Password-protected rung and no valid `__canvasdrop_gate` cookie. The gate that sets the cookie lives on the canvas page, not under `/v1/c/`; this API only checks it. Guests skip the gate. |
| `STATIC_ONLY` | 403 | Public link canvas and the viewer is not the owner or an editor. Applies to signed-in members as well as anonymous visitors: the whole runtime API is closed. Body: `{ code, message }`. |

A guest principal reaches the handlers as a synthetic user whose `id` is namespaced
`guest:<inviteId>`, never as an admin.

**4. Cross-canvas isolation.**

| Mode | Rule | Response |
|---|---|---|
| `subdomain` | `Origin` present and not exactly `https://{slug}.{baseHost}` | `403 CROSS_CANVAS_FORBIDDEN` |
| `path` | `Sec-Fetch-Site` present and not `same-origin` or `none` | `403 CROSS_SITE_FORBIDDEN` |
| `path` | `Referer` path not `/c/{slug}` or beneath it | `403 CROSS_CANVAS_FORBIDDEN` |

In `subdomain` mode a request with no `Origin` passes (a programmatic caller), and a
matching `Origin` gets credentialed CORS headers: `Access-Control-Allow-Origin: <origin>`,
`Access-Control-Allow-Credentials: true`, `Vary: Origin`. In `path` mode the canvas is
same-origin and no CORS headers are sent.

Preflight `OPTIONS /v1/c/{slug}/*` is answered before the auth gateway: always `204`,
`Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS`,
`Access-Control-Allow-Headers: Content-Type`, plus the credentialed headers above in
`subdomain` mode when `Origin` matches.

**5. Capability gate.** Each primitive checks its capability and returns `403` when it is
off:

```json
{ "code": "CAPABILITY_DISABLED", "capability": "kv", "backendEnabled": true, "reason": "feature_off", "hint": "..." }
```

`reason` is `backend_off`, `feature_off`, or `operator_disabled`; `hint` is a short
remediation string. Effective rules: `identity` needs the canvas backend on; `kv` and
`files` need the backend plus their own switch; `ai` also needs a provider key configured;
`realtime` also needs `CANVAS_DROP_REALTIME=on`; `authoring` also needs
`CANVAS_DROP_AUTHORING=on`.

## Identity

Capability: `identity` (on whenever the canvas backend is on).

```
GET {base}/v1/c/{slug}/me   → 200 { id, email, name, avatarUrl, kind }
```

`avatarUrl` may be `null`. `kind` is `"member"` for a signed-in org member; `"guest"` is
retained for legacy guest sessions. The response deliberately omits `isAdmin`; that lives
on the dashboard's `/api/me`, covered under Adjacent endpoints below. An anonymous
visitor never reaches this handler: a Public link canvas answers `STATIC_ONLY` first.

## Key-value

Capability: `kv`. Two scopes with the same five routes:

- Shared at `/kv`: one namespace for every viewer of the canvas.
- Per-viewer at `/kv/user`: scoped to the caller's server-resolved user id. The client
  never names the scope.

```
GET    {base}/v1/c/{slug}/kv?prefix=&cursor=&limit=   list       → 200 { entries: [{ key, value }], nextCursor }
GET    {base}/v1/c/{slug}/kv/{key}                    read       → 200 { value }        404 NOT_FOUND if absent
PUT    {base}/v1/c/{slug}/kv/{key}                    write      → 200 { ok: true }     body = the JSON value
DELETE {base}/v1/c/{slug}/kv/{key}                    delete     → 200 { ok: true }     idempotent, never 404
POST   {base}/v1/c/{slug}/kv/{key}/increment          atomic add → 200 { value }        body { by?: number }
```

Replace `/kv` with `/kv/user` for the per-viewer scope. URL-encode keys in the path.

- `list`: `limit` is clamped to 1..1000 (default 100, non-numeric ignored); pagination is
  keyset on `key`; `nextCursor` is `null` on the last page.
- `PUT`: the body is the value itself, any JSON except `null`. `null` and unparseable JSON
  are `400 INVALID_BODY` (delete the key instead of storing `null`).
- `increment`: `by` defaults to `1` and must be a finite number (`400 INVALID_BODY`); a
  malformed body is treated as `{}`. An existing non-numeric value is `409 NOT_NUMERIC`.

Limits: key ≤ 512 bytes (`413 KEY_TOO_LARGE`), serialized value ≤ 64 KiB
(`413 VALUE_TOO_LARGE`), 10 000 shared keys and 1 000 per-viewer keys per canvas
(`409 KEY_LIMIT`, admin-tunable). The key cap applies to new keys; updating an existing
key always succeeds.

## Files

Capability: `files`.

```
POST   {base}/v1/c/{slug}/files              upload   → 201 { id, name, size, url }
GET    {base}/v1/c/{slug}/files              list     → 200 { files: [{ id, name, size, mime, createdAt }] }
GET    {base}/v1/c/{slug}/files/{id}/content download → 200 raw bytes          404 NOT_FOUND
DELETE {base}/v1/c/{slug}/files/{id}         delete   → 200 { ok: true }       404 NOT_FOUND
```

Upload is `multipart/form-data` with the file in a field named `file`; the name defaults
to `upload` and the type to `application/octet-stream` when the part carries none. The
returned `url` is root-relative (`/v1/c/{slug}/files/{id}/content`); the SDK rewrites it
to an absolute URL on the API base, which matters in `subdomain` mode.

Content is served with `X-Content-Type-Options: nosniff` and a sanitized filename. Only
safe raster images render inline; everything else, SVG included, is sent as `attachment`.

Limits: 25 MiB per file (`413 FILE_TOO_LARGE`), 1 GiB per canvas (`409 QUOTA_EXCEEDED`).
A missing or non-multipart body is `400 INVALID_BODY`.

## AI

Capability: `ai`. Effective only when the canvas has `ai` on and the instance has a
provider key configured; the key stays server-side and never appears in a response. This
route uses the stricter `ai` rate-limit class (default 10/min per user).

```
POST   {base}/v1/c/{slug}/ai/chat            chat completion → 200 SSE stream
```

Request body (JSON, ≤ 256 KiB):

```json
{
  "model": "<provider model id>",
  "messages": [{ "role": "user", "content": "Hello" }],
  "system": "optional system prompt",
  "maxTokens": 1024
}
```

`model` is required and must be on the instance allowlist. `messages` needs at least one
entry, each with role `user` or `assistant`; the system prompt goes in `system`, not in a
message. `maxTokens` defaults to 1024 and is capped at 8192.

The response is `text/event-stream`. Each event is one JSON `data:` line:

```
data: {"type":"delta","text":"Hel"}
data: {"type":"delta","text":"lo"}
data: {"type":"done","usage":{"inputTokens":12,"outputTokens":2,"cacheCreationInputTokens":0,"cacheReadInputTokens":0},"cost":0.000123}
```

`cost` is in USD. The cache fields report prompt-cache writes and reads when the provider
supplies them, `0` otherwise. With the Anthropic provider the server marks the stable
prefix for ephemeral prompt caching: the `system` prompt and the conversation before the
newest user turn.

Errors, by when they happen:

- Before the stream (JSON body, normal status): `413 BODY_TOO_LARGE`,
  `400 INVALID_BODY`, `403 MODEL_NOT_ALLOWED` (not allowlisted, or allowlisted but
  unpriced), `403 GUEST_AI_DISABLED` (legacy guest session on a canvas with guest AI off),
  `429 GUEST_AI_CAP` (`scope: "guest"`), `429 QUOTA_EXCEEDED` (`scope: "user_daily"` or
  `"canvas_monthly"`, the USD spend caps), `403 CAPABILITY_DISABLED` (no effective
  provider key after the gate).
- During the stream (HTTP is already 200): a final
  `{"type":"error","code":"AI_UPSTREAM_ERROR","message":"the AI provider returned an error"}`
  event.

Usage and spend are recorded exactly once per request, including when the client aborts
mid-stream.

## Realtime

Capability: `realtime`. The route is mounted only when the instance wires a WebSocket
adaptor; the capability is effective only with `CANVAS_DROP_REALTIME=on` plus the canvas
switch.

```
GET    {base}/v1/c/{slug}/realtime           WebSocket upgrade (ws:// or wss:// on the API base)
```

The full pipeline above runs before the upgrade: a failed login, authorization, password
gate, or isolation check refuses the `101` with the usual HTTP error. After the socket is
open, the server closes it with one of three codes:

| Close code | When |
|---|---|
| `4403` | `realtime` is off. The server first sends `{"type":"error","code":"CAPABILITY_DISABLED","capability":"realtime"}`, then closes. Also used when realtime is switched off mid-session. |
| `4429` | The canvas already has 30 open connections. |
| `4401` | Access was lost on revalidation: canvas gone, access removed, canvas became a Public link, password gate no longer satisfied, or the user deactivated. |

Frames are JSON text, ≤ 16 KiB each. Client to server:

| Frame | Purpose |
|---|---|
| `{"type":"subscribe","channel"}` | Join a channel; the server answers `subscribed`. |
| `{"type":"unsubscribe","channel"}` | Leave it. |
| `{"type":"publish","channel","event"?,"data"?}` | Fan a message out to the channel's subscribers. |
| `{"type":"presence","channel"}` | Ask who is on the channel. |

Server to client:

| Frame | Meaning |
|---|---|
| `{"type":"subscribed","channel"}` | Subscription confirmed. |
| `{"type":"message","channel","event","data","from":{id,name}}` | A published message. `from` is resolved server-side; a client cannot spoof it. |
| `{"type":"presence","channel","users":[{id,name}]}` | Current members. |
| `{"type":"join"\|"leave","channel","user":{id,name}}` | Membership change. |
| `{"type":"error","code","message"}` | `MESSAGE_TOO_LARGE`, `INVALID_FRAME`, `CHANNEL_NAME_TOO_LARGE`, `CHANNEL_LIMIT`, `RATE_LIMITED`, `UNKNOWN_FRAME`. |

Per-connection limits: channel names ≤ 128 bytes, 64 channels, 100 publishes per minute.
The SDK's `canvasdrop.realtime.channel(name)` handles framing, reconnection, and presence;
see [Realtime](/docs/sdk/realtime).

## Authoring

Capability: `authoring`. Off by default; needs the canvas switch and the instance switch
`CANVAS_DROP_AUTHORING=on`. Lets a signed-in org member create and manage further canvases
(managed shares) from inside a canvas. Guests and anonymous visitors get
`401 NOT_AUTHENTICATED`.

```
POST   {base}/v1/c/{slug}/authoring          publish a new canvas → 200 AuthoredCanvas
PUT    {base}/v1/c/{slug}/authoring/{id}     update in place      → 200 AuthoredCanvas
GET    {base}/v1/c/{slug}/authoring          list your shares     → 200 { canvases: [AuthoredCanvas] }
DELETE {base}/v1/c/{slug}/authoring/{id}     revoke               → 204
```

`POST` and `PUT` are `multipart/form-data` with two parts: `metadata`, a JSON string, and
`bundle`, a zip of the static site. The bundle is required on `POST` and optional on
`PUT`; a bundle on `PUT` publishes a new version at the same URL, and omitting it changes
settings only.

`metadata` fields:

| Field | `POST` | `PUT` | Notes |
|---|---|---|---|
| `title` | required, 1-200 chars | optional | |
| `slug` | optional | not accepted | Custom slug. Invalid: `400 INVALID_BODY` with `reason: "invalid_slug"`; in use: `409 SLUG_TAKEN`. |
| `tags` | optional | optional | Up to 20, each 1-64 chars. |
| `access` | optional, default `private` | optional | `private`, `specific_people`, `whole_org`, `public_link`, or `password` (a Public link with a password). Must be in `CANVAS_DROP_AUTHORING_ALLOWED_RUNGS`, else `400 INVALID_BODY`. |
| `password` | optional, 1-200 chars | optional; `null` clears | Required when `access` is `password`. |
| `expiresAt` | optional, epoch ms | optional; `null` clears | Must be in the future and within `CANVAS_DROP_AUTHORING_MAX_EXPIRY_DAYS`; required when `CANVAS_DROP_AUTHORING_REQUIRE_EXPIRY` is on. |
| `metadata` | optional object | optional | Free-form, ≤ 16 KiB. |

`POST` creates the canvas under your account, deploys the bundle, and applies the sharing
settings in one call. It counts against the authoring quota (`429 QUOTA_EXCEEDED` with
`scope: "user_daily"` or `"user_total"`; defaults 20 per day and 200 total, set by
`CANVAS_DROP_AUTHORING_USER_DAILY_MAX` and `CANVAS_DROP_AUTHORING_USER_TOTAL_MAX`). `PUT`
requires you to be the owner or an editor of `{id}` and does not consume quota.

`GET` returns the active shares you authored and still manage as owner or editor,
including revoked and expired ones, each with a derived `status`: `revoked`, `expired`,
`private`, or `live` (first match wins). Filters: `?sourceApp=&sourceKind=&tags=a,b`
(every listed tag must match). The response is `Cache-Control: private, no-store`.

`DELETE` revokes: the URL stops serving and `revokedAt` is set, but the record stays
listed as `status: "revoked"`. A later `PUT` with a bundle publishes it again; a
settings-only `PUT` on a revoked share is `409 SHARE_REVOKED`.

`AuthoredCanvas`: `{ id, url, title, tags, access, hasPassword, status, createdAt,
updatedAt, expiresAt, revokedAt, createdBy, version, bundleUpdatedAt, sourceApp,
sourceKind, metadata }`.

| Code | HTTP | When |
|---|---|---|
| `NOT_AUTHENTICATED` | 401 | Guest or anonymous caller. |
| `INVALID_BODY` | 400 | Bad or missing multipart, schema failure, empty bundle, rung not allowed, missing password for `password` access, expiry missing, past, or over the maximum. `reason` may be `org_forbidden` or `invalid_slug`. |
| `INVALID_BODY` | 413 | Bundle over 50 MiB (`message: "bundle too large"`). |
| `ORG_REQUIRED` | 409 | `access: whole_org` requested while the caller (or, on `PUT`, the canvas) has no home org under tenancy. |
| `PUBLIC_LINKS_DISABLED` | 403 | A Public link requested while the instance has public links off. |
| `PUBLIC_NOT_ALLOWED` | 403 | A Public link requested by an owner whose account may not publish public links. |
| `PUBLIC_LINK_OWNER_GATED` | 403 | `PUT` by an editor requesting a Public link on a canvas whose owner may not publish them. |
| `QUOTA_EXCEEDED` | 429 | `POST` only; `scope` is `user_daily` or `user_total`. |
| `SLUG_TAKEN` | 409 | `POST` with a custom slug already in use. |
| `NOT_FOUND` | 404 | `PUT` or `DELETE` on a canvas you hold no role on, or that is missing or deleted. |
| `DISABLED` | 409 | `PUT` or `DELETE` on an admin-disabled canvas. |
| `SHARE_REVOKED` | 409 | Settings-only `PUT` on a revoked share. |
| `PUBLISH_FAILED` | 502 | The record exists but its deploy or share config failed; `id` is included so you can retry or revoke. |

The SDK wraps these four routes as [`canvasdrop.canvases`](/docs/sdk/authoring).

## Adjacent endpoints

Not under `/v1/c/{slug}`, but part of the browser-facing surface:

```
GET {base}/sdk/v1.js   the browser SDK bundle
GET {base}/api/me      dashboard identity and instance config
```

`/sdk/v1.js` sits behind the auth gateway, is served as
`application/javascript; charset=utf-8` with `cache-control: public, max-age=3600`, is not
rate-limited, and answers `503` (plain text) when the bundle has not been built
(`pnpm build`).

`/api/me` is the dashboard's identity call:
`{ id, email, name, avatarUrl, isAdmin, orgs: [{ id, name }], isGuest, canPublishPublic, authMode, urlMode, baseUrl, designSkin }`.
`authMode` is `proxy`, `oidc`, or `dev`; `urlMode` is `path` or `subdomain`. It is not
capability-gated and uses the `management` rate-limit class
(`429 {"error":"rate_limited"}`). Canvas code should call `/v1/c/{slug}/me` instead.

## Errors

Every `code` is stable; branch on it, never on message text. The full list is on
[Error codes](/docs/api/errors).
