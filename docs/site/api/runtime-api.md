# Runtime API

The runtime API is the HTTP surface a canvas calls from the browser: the six fixed primitives
(KV, files, AI, identity, realtime, and admin-granted Connections) plus authoring, each under `{base}/v1/c/{slug}`. The
[browser SDK](/docs/sdk/overview) (`window.canvasdrop`, served at `{base}/sdk/v1.js`)
builds every one of these requests, speaks the SSE and WebSocket wire formats, and maps
errors to typed exceptions, so reach for it first. Use this page when you need the raw
routes: reading the network tab, a non-JS client, or the exact shape a primitive returns.

Requests are credentialed with the session cookie the browser already holds. Identity is
resolved server-side from that session; the canvas never asserts who the viewer is.

```js
// Inside a canvas served in path mode at http://localhost:3000/c/quiet-otter-x7k2/
const api = "/v1/c/quiet-otter-x7k2";

await fetch(`${api}/kv/greeting`, {
  method: "PUT",
  credentials: "include",
  headers: { "content-type": "application/json" },
  body: JSON.stringify("hi"),                  // the body is the value itself
});
// 200 {"ok":true}
const { value } = await (await fetch(`${api}/kv/greeting`, { credentials: "include" })).json();
// 200 {"value":"hi"}

// The same two calls through the SDK:
await canvasdrop.kv.set("greeting", "hi");
await canvasdrop.kv.get("greeting");            // "hi"
```

## Where the API lives

| URL mode | Canvas content | Runtime API |
|---|---|---|
| `path` | `{base}/c/{slug}/` | Same origin: `{base}/v1/c/{slug}/...` |
| `subdomain` | `https://{slug}.canvases.example.com/` | The base host: `https://canvases.example.com/v1/c/{slug}/...` |

The route path is identical in both modes; only the origin changes. The SDK derives it
from `location`: a pathname starting `/c/{slug}` means `path` mode and `location.origin`;
otherwise it strips the first hostname label and keeps the port. Every request goes out
with `credentials: "include"`. `CANVAS_DROP_API_BASE_URL` shapes the Bearer-key
[Deploy API](/docs/api/deploy-api) URLs (`/v1/canvases/...`), not this surface.

## Before a handler runs

Every `/v1/c/{slug}/*` request passes the same pipeline, in this order. Any route on this
page can return these.

**1. Auth gateway.** No session: `401 {"error":"unauthorized"}` in `proxy` and `dev`
mode, or a `302` to `/auth/login` in `oidc` mode. One carve-out: an anonymous visitor to
an active, unexpired Public link canvas (public links on for the instance and for the
owner) is let through as an anonymous principal, then refused with `STATIC_ONLY` in
step 3.

**2. Rate limit.** `429 {"code":"RATE_LIMITED"}` with `Retry-After`, `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, `X-RateLimit-Reset`. Two classes:

| Class | Paths | Keyed | Default | Env |
|---|---|---|---|---|
| `ai` | `/v1/c/{slug}/ai*` | per user | 10/min | `CANVAS_DROP_RATELIMIT_AI_PER_MIN` |
| `canvas` | everything else under `/v1/c/{slug}` | per user per canvas | 120/min | `CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN` |

`CANVAS_DROP_RATELIMIT_ENABLED=false` skips this step.

**3. Resolve and authorize.** The canvas is looked up by slug and the viewer is checked
against its sharing rung, then the password gate, then the static-only rule. The owner
and effective editors pass the rung and the password gate. A non-owner admin has no
bypass here: they face the rung and the gate like any other member.

| Code | HTTP | When |
|---|---|---|
| `NOT_FOUND` | 404 | Unknown slug, or the canvas is deleted. |
| `ARCHIVED` | 404 | The canvas is archived. |
| `DISABLED` | 403 | An admin disabled the canvas. The owner is not exempt. |
| `NOT_INVITED` | 404 | A guest principal scoped to a different canvas. |
| `OWNER_ONLY` | 404 | The viewer has no route in: not on the people-and-teams list (directly or through a team) and not admitted by General access — Restricted, Whole org as a non-member (or, under tenancy, a member of another org), or Public link while public links are off for the instance or for the owner. |
| `SHARE_EXPIRED` | 404 | The share's expiry has passed (for anyone but the owner and editors). |
| `PASSWORD_REQUIRED` | 403 | A shared canvas with a password set and no valid `__canvasdrop_gate` cookie. The gate that sets the cookie lives on the canvas page, not under `/v1/c/`; this API only checks it. Guests skip the gate. |
| `STATIC_ONLY` | 403 | Public link canvas and the viewer is not the owner or an editor. Applies to signed-in members as well as anonymous visitors: the whole runtime API is closed. Body: `{"code":"STATIC_ONLY","message":"This canvas is public and static-only."}`. |

A guest principal reaches the handlers as a synthetic user whose `id` is
`guest:<inviteId>`, never as an admin and never able to publish public links.

**4. Cross-canvas isolation.**

| Mode | Rule | Response |
|---|---|---|
| `subdomain` | `Origin` present and not exactly `https://{slug}.{baseHost}` | `403 CROSS_CANVAS_FORBIDDEN` |
| `path` | `Sec-Fetch-Site` present and not `same-origin` or `none` | `403 CROSS_SITE_FORBIDDEN` |
| `path` | `Referer` path not `/c/{slug}` or beneath it | `403 CROSS_CANVAS_FORBIDDEN` |

In `subdomain` mode a request with no `Origin` passes (a programmatic caller), and a
matching `Origin` gets credentialed CORS headers: `Access-Control-Allow-Origin: <origin>`,
`Access-Control-Allow-Credentials: true`, `Vary: Origin`. Those headers are applied before
the step 3 refusals, so `STATIC_ONLY` and `PASSWORD_REQUIRED` reach the SDK as readable
JSON rather than a CORS failure. In `path` mode the canvas is same-origin and no CORS
headers are sent.

Preflight `OPTIONS /v1/c/{slug}/*` is answered before the auth gateway: always `204`,
`Access-Control-Allow-Methods: GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS`, and either
`Access-Control-Allow-Headers: Content-Type` or the canvas origin's requested header names,
plus the credentialed headers above in
`subdomain` mode when `Origin` matches. It never returns `401`.

**5. Capability gate.** Each primitive checks its capability and returns `403` when it is
off:

```json
{ "code": "CAPABILITY_DISABLED", "capability": "kv", "backendEnabled": true, "reason": "feature_off", "hint": "..." }
```

`reason` is `backend_off`, `feature_off`, or `operator_disabled`; `hint` is a short
remediation string.

| Capability | Effective when |
|---|---|
| `identity` | the canvas backend is on |
| `kv`, `files` | backend on, plus the capability's own switch |
| `ai` | backend on, switch on, and the instance has a provider key |
| `realtime` | backend on, switch on, and `CANVAS_DROP_REALTIME=on` (the default) |
| `connections` | backend on, plus a live enabled profile and per-canvas admin grant; the external encryption key must be available when the profile has protected headers |
| `authoring` | backend on, switch on, and `CANVAS_DROP_AUTHORING=on` (default `off`) |

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
  never names the scope, and `user` is never read as a key.

```
GET    {base}/v1/c/{slug}/kv?prefix=&cursor=&limit=   list       → 200 { entries: [{ key, value }], nextCursor }
GET    {base}/v1/c/{slug}/kv/{key}                    read       → 200 { value }        404 NOT_FOUND if absent
PUT    {base}/v1/c/{slug}/kv/{key}                    write      → 200 { ok: true }     body = the JSON value
DELETE {base}/v1/c/{slug}/kv/{key}                    delete     → 200 { ok: true }     idempotent, never 404
POST   {base}/v1/c/{slug}/kv/{key}/increment          atomic add → 200 { value }        body { by?: number }
```

Replace `/kv` with `/kv/user` for the per-viewer scope. `{key}` is one path segment;
URL-encode it.

- `list`: `limit` is clamped to 1..1000 (default 100, non-numeric ignored); entries come
  back in key order; `nextCursor` is the last key on the page and `null` on the last page.
- `read`: a stored JSON `null` reads as `{ "value": null }`.
- `PUT`: the body is the value itself (`content-type: application/json`), any JSON except
  `null`. Unparseable JSON and `null` are `400 INVALID_BODY` (delete the key instead of
  storing `null`).
- `increment`: `by` defaults to `1` and must be a finite number (`400 INVALID_BODY`); a
  missing or malformed body counts as `{}`. A missing key starts at `0`. An existing
  non-numeric value (a stored `null` included) is `409 NOT_NUMERIC`.

Limits: key ≤ 512 bytes (`413 KEY_TOO_LARGE`), serialized value ≤ 64 KiB
(`413 VALUE_TOO_LARGE`), 10 000 shared keys and 1 000 per-viewer keys per canvas
(`409 KEY_LIMIT`; admin-tunable quota keys `kv.keys.shared` and `kv.keys.user`). The key
cap applies to new keys; updating an existing key always succeeds. Checks run in the
order key size, body, value size, key count.

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

Content is served with `Content-Type` set to the stored mime,
`X-Content-Type-Options: nosniff`, and a sanitized filename (`filename` plus RFC 5987
`filename*`). Only `image/png`, `image/jpeg`, `image/gif`, `image/webp`, and `image/avif`
render inline; everything else, SVG and HTML included, is sent as `attachment`.

Limits: 25 MiB per file (`413 FILE_TOO_LARGE`, from either the transport body cap or the
per-file quota), 1 GiB per canvas (`409 QUOTA_EXCEEDED`); both admin-tunable
(`files.bytes.file`, `files.bytes.canvas`). A missing or non-multipart body is
`400 INVALID_BODY`. `DELETE` and `content` answer `404 NOT_FOUND` for a file that belongs
to another canvas.

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
message. `maxTokens` is a positive integer, defaults to 1024, and is capped at 8192.

The response is `text/event-stream`. Each event is one JSON `data:` line:

```
data: {"type":"delta","text":"Hel"}
data: {"type":"delta","text":"lo"}
data: {"type":"done","usage":{"inputTokens":12,"outputTokens":2,"cacheCreationInputTokens":0,"cacheReadInputTokens":0},"cost":0.000123}
```

`cost` is in USD. The cache fields report prompt-cache writes and reads when the provider
supplies them, `0` otherwise. With the Anthropic provider the server sets ephemeral cache
breakpoints on the `system` prompt and on the last message before the newest user turn,
so a stable conversation prefix is cached across calls.

Errors, by when they happen:

- Before the stream (JSON body, normal status), in this order: `413 BODY_TOO_LARGE`,
  `400 INVALID_BODY`, `403 MODEL_NOT_ALLOWED` (not allowlisted, or allowlisted but
  unpriced), `403 GUEST_AI_DISABLED` (legacy guest session on a canvas with guest AI off),
  `429 GUEST_AI_CAP` (`scope: "guest"`), `429 QUOTA_EXCEEDED` (`scope: "user_daily"` or
  `"canvas_monthly"`, the USD spend caps), `403 CAPABILITY_DISABLED` (no effective
  provider key after the gate).
- During the stream (HTTP is already `200`): a final
  `{"type":"error","code":"AI_UPSTREAM_ERROR","message":"the AI provider returned an error"}`
  event. The SDK raises `AI_STREAM_TRUNCATED` (502) itself when the stream ends with
  neither `done` nor `error`.

Usage and spend are recorded exactly once per request: on success, on upstream error, and
when the client aborts mid-stream.

## Outbound Connections

Capability: `connections`. A grant, not a canvas-owned feature flag, is the
switch. An instance administrator defines one exact HTTPS origin, the allowed
standard methods, and optional protected headers, then attaches that profile to
individual canvases. Backend must also be on.

```
GET|HEAD|POST|PUT|PATCH|DELETE
  {base}/v1/c/{slug}/connections/{profile}/{relative-path}?query
```

`{relative-path}` stays under the approved origin. An empty suffix means `/`.
Only methods selected for the profile are accepted. `GET` and `HEAD` have no
request body; the other supported methods accept at most 256 KiB. Canvas caller
headers are limited to 32 and 16 KiB total. Cookies, authorization, forwarding,
host, compression, and hop-by-hop headers are stripped; fixed protected headers
are applied last.

The upstream response status and bounded body are returned unchanged, including
`4xx` and `5xx`, with only safe response headers. Canvas Drop adds
`X-Canvas-Drop-Connection-Response: upstream`, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, and `Content-Security-Policy: sandbox`.
Upstream cookies, redirects, CORS policy, server identification, and hop-by-hop
headers are removed. Non-identity content encoding is refused.

Platform failures are JSON and carry one of the stable connection codes on the
[Error codes](/docs/api/errors) page. Default bounds are an 8 KiB relative URL,
2 MiB response, 10-second total DNS/request/body deadline, three exact-origin
redirects, 60 requests/minute per actor+canvas+profile, 600/minute per profile,
five concurrent requests per canvas, and 50 per server process.

Security is enforced before every socket: IP literals and non-HTTPS origins are
invalid; every A/AAAA answer must be public; mixed public/private answers reject;
the validated address is pinned to the socket while TLS verifies the approved
hostname; every redirect retains the exact origin and re-runs DNS validation.
See [Outbound Connections](/docs/sdk/connections) for the SDK contract and the
remaining upstream-reflection trust boundary.

## Realtime

Capability: `realtime`. Effective only with `CANVAS_DROP_REALTIME=on` (the default) plus
the canvas switch. The route exists only where the server wires a WebSocket adaptor (the
Node server does).

```
GET    {base}/v1/c/{slug}/realtime           WebSocket upgrade (ws:// or wss:// on the API base)
```

The full pipeline above runs before the upgrade: a failed login, authorization, password
gate, or isolation check refuses the `101` with the usual HTTP error. After the socket is
open, the server closes it with one of these codes:

| Close code | When |
|---|---|
| `4403` | `realtime` is off. The server first sends `{"type":"error","code":"CAPABILITY_DISABLED","capability":"realtime"}`, then closes. Also used when realtime is switched off mid-session. |
| `4429` | The canvas already has 30 open connections (`"connection limit"`). |
| `4401` | Access was lost on revalidation: canvas gone, access removed, the canvas became a Public link (static-only), a password gate was set, or the user was deactivated. |
| `1001` | Server shutdown. |

Limits: 30 connections per canvas, 100 publishes per minute per connection, 16 KiB per
frame. The SDK treats `4401`, `4403`, and `4429` as terminal and does not reconnect.

Frames are JSON text, ≤ 16 KiB each, all scoped to the canvas from the handshake. Client
to server:

| Frame | Purpose |
|---|---|
| `{"type":"subscribe","channel"}` | Join a channel; the server answers `subscribed` and a `presence` snapshot, and tells other subscribers `join`. |
| `{"type":"unsubscribe","channel"}` | Leave it; others get `leave` once the user's last connection is gone. |
| `{"type":"publish","channel","event","data"}` | Fan a message out to the channel's subscribers. A missing `event` is sent as `""`. |
| `{"type":"presence","channel"}` | Ask who is on the channel. |

Server to client:

| Frame | Meaning |
|---|---|
| `{"type":"subscribed","channel"}` | Subscription confirmed. |
| `{"type":"message","channel","event","data","from":{id,name}}` | A published message. `from` is resolved server-side; a client cannot spoof it. |
| `{"type":"presence","channel","users":[{id,name}]}` | Current members. |
| `{"type":"join"\|"leave","channel","user":{id,name}}` | Membership change. |
| `{"type":"error","code","message"}` | `MESSAGE_TOO_LARGE` (> 16 KiB), `INVALID_FRAME` (not JSON), `CHANNEL_NAME_TOO_LARGE` (> 128 bytes), `CHANNEL_LIMIT` (> 64 channels on one connection), `RATE_LIMITED` (> 100 publishes per minute on one connection), `UNKNOWN_FRAME`. |

The SDK's `canvasdrop.realtime.channel(name)` handles framing, reconnection, and presence;
see [Realtime](/docs/sdk/realtime).

## Authoring

Capability: `authoring`. Off by default; needs the canvas switch and the instance switch
`CANVAS_DROP_AUTHORING=on`. Lets a signed-in org member create and manage further
canvases (managed shares) from inside a canvas. A legacy guest principal gets
`401 NOT_AUTHENTICATED`; an anonymous visitor never gets this far (`STATIC_ONLY`).

```
POST   {base}/v1/c/{slug}/authoring          publish a new canvas → 200 AuthoredCanvas
PUT    {base}/v1/c/{slug}/authoring/{id}     update in place      → 200 AuthoredCanvas
GET    {base}/v1/c/{slug}/authoring          list your shares     → 200 { canvases: [AuthoredCanvas] }
DELETE {base}/v1/c/{slug}/authoring/{id}     revoke               → 204
```

`POST` and `PUT` are `multipart/form-data` with two parts: `metadata`, a JSON string, and
`bundle`, the static-site zip (required on `POST`, optional on `PUT`, never empty). The
password is an optional lock independent of the audience; `access: "password"` is the
compatibility shorthand for a Public link plus a password.

| `metadata` field | `POST` | `PUT` | Notes |
|---|---|---|---|
| `title` | required, 1-200 chars | optional | |
| `slug` | optional | not accepted | Custom slug. Invalid: `400 INVALID_BODY` with `reason: "invalid_slug"`; in use: `409 SLUG_TAKEN`. |
| `tags` | optional | optional | Up to 20, each 1-64 chars. |
| `access` | optional, default `private` | optional | `private` (Restricted: the people-and-teams list only), `whole_org`, `public_link`, or `password` (a Public link with a password); `specific_people` is accepted as a legacy alias of `private`. Must be in `CANVAS_DROP_AUTHORING_ALLOWED_RUNGS` (default `private,specific_people,whole_org,public_link`; `public_link` covers `password`), else `400 INVALID_BODY`. |
| `password` | optional, 1-200 chars | optional; `null` clears | Required when `access` is `password`. |
| `expiresAt` | optional, epoch ms | optional; `null` clears | Must be in the future and within `CANVAS_DROP_AUTHORING_MAX_EXPIRY_DAYS` (default `0`, no cap); required when `CANVAS_DROP_AUTHORING_REQUIRE_EXPIRY` is on (default off). |
| `metadata` | optional object | optional | Free-form, ≤ 16 KiB. |
| `expectedUpdatedAt` | not accepted | optional, epoch ms | Compare-and-swap token: the `updatedAt` you last read. A stale value is refused with `409 SHARE_CONFLICT` and the current record. |

**`POST`** creates the canvas under your account, deploys the bundle, and applies the
share settings in one call. It counts against the authoring quota (`429 QUOTA_EXCEEDED`
with `scope: "user_daily"` or `"user_total"`; defaults 20 per day and 200 total, set by
`CANVAS_DROP_AUTHORING_USER_DAILY_MAX` and `CANVAS_DROP_AUTHORING_USER_TOTAL_MAX`). A
deploy or share-config failure after the row exists still counts.

**`PUT`** updates an existing share in place: a new immutable version at the same URL when
`bundle` is included, settings and metadata only when it is omitted. You must be the
owner or an editor of `{id}` (an instance admin acting on a known id also passes);
anything else reads as `404 NOT_FOUND`. It does not consume quota. Gates are checked
against the share's resulting state, so clearing a password or dropping an expiry on a
Public link faces the same checks a fresh publish would. Settings are saved before the
bundle deploys: if the deploy then fails, the response is `502 UPDATE_PARTIAL` with
`stage` and the saved `current` record, so nothing you changed is lost.

**`GET`** returns the shares you authored and still manage as owner or editor, including
draft, revoked, expired, archived, and admin-disabled rows. Deleted canvases are omitted.
Filters: `?sourceApp=&sourceKind=&tags=a,b` (every listed tag must match). The response
is `Cache-Control: private, no-store`.

**`DELETE`** revokes: the URL stops serving and `revokedAt` is set, but the record stays
listed with `status: "revoked"`. A later `PUT` with a bundle publishes it again; a
settings-only `PUT` on a revoked share is `409 SHARE_REVOKED`.

`AuthoredCanvas`:

```
{ id, url, title, tags, access, accessMode, publicationStatus, hasPassword, status,
  createdAt, updatedAt, expiresAt, galleryListed, galleryTemplatable, discoverability,
  revokedAt, createdBy, viewerRole, audienceSummary, version, bundleUpdatedAt, sourceApp,
  sourceKind, metadata }
```

`accessMode` is the audience: `restricted` (`access` is `private` or a legacy alias —
only the people and teams on the list, who are admitted at every value), `whole_org`, or
`public_link`. `publicationStatus` is the lifecycle, independent of the audience, first
match wins: `disabled`, `archived`, `unpublished` (`revokedAt` set), `draft` (no version),
`expired` (`expiresAt` passed), else `published`; deleted canvases never appear. The older
`status` (`revoked` › `expired` › `private` › `live`) is deprecated and frozen: its `private`
means the persisted value is literally `private`, not that nobody can open the share. `version` is the id of the
current published version (`null` when none) and advances on every deploy;
`bundleUpdatedAt` is the row's last write (deploy or settings), the same value as
`updatedAt`, so watch `version` to detect a bundle change. `sourceApp` and `sourceKind`
are read from the free-form `metadata` when they are strings. `viewerRole` (`owner`,
`editor`, or `admin`) says why you may manage the record; `audienceSummary`
(`{ count, names }`) is a safe summary of the people and teams on its list.

| Code | HTTP | When |
|---|---|---|
| `NOT_AUTHENTICATED` | 401 | Legacy guest caller. |
| `INVALID_BODY` | 400 | Not multipart, `metadata` missing or not JSON, `bundle` missing (`POST`) or empty, schema failure, rung not allowed, missing password for `password` access, expiry missing, past, or over the maximum, `metadata` over 16 KiB. `reason` may be `org_forbidden` or `invalid_slug`. |
| `INVALID_BODY` | 413 | Bundle over 50 MiB (`message: "bundle too large"`). |
| `ORG_REQUIRED` | 409 | `access: whole_org` requested while the caller (or, on `PUT`, the canvas) has no home org under tenancy. |
| `PUBLIC_LINKS_DISABLED` | 403 | A Public link requested while the instance has public links off. |
| `PUBLIC_NOT_ALLOWED` | 403 | A Public link requested by an owner whose account may not publish public links. |
| `PUBLIC_LINK_OWNER_GATED` | 403 | `PUT` by an editor requesting a Public link on a canvas whose owner may not publish them. |
| `QUOTA_EXCEEDED` | 429 | `POST` only; `scope` is `user_daily` or `user_total`. |
| `SLUG_TAKEN` | 409 | `POST` with a custom slug already in use. |
| `NOT_FOUND` | 404 | `PUT` or `DELETE` on a canvas you hold no role on, or that is missing, deleted, or (for `DELETE`) not active. |
| `DISABLED` | 409 | `PUT` or `DELETE` on an admin-disabled canvas. Note the status: `409` here, `403` from the shared pipeline. |
| `SHARE_REVOKED` | 409 | Settings-only `PUT` on a revoked share. |
| `SHARE_CONFLICT` | 409 | `PUT` with a stale `expectedUpdatedAt`; the body carries the current record. |
| `PUBLISH_FAILED` | 502 | Create, deploy, or share config failed. `id` is included once the record exists so you can retry or revoke. |
| `UPDATE_PARTIAL` | 502 | `PUT` saved the settings but the bundle deploy failed; `stage` and `current` are included. |

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

Every `code` is stable; branch on it, never on message text. The full list, with the
SDK's exception classes, is on [Error codes](/docs/api/errors).
