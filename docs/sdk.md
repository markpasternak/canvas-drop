# Browser SDK (`canvasdrop`)

Give a static canvas a backend without a build step and without a secret in the
page. One `<script>` tag defines the `canvasdrop` global, which exposes the five
primitives: KV (`kv`), files (`files`), AI (`ai`), identity (`me()`), and
realtime (`realtime`). Identity comes from the viewer's signed-in session; the
canvas is identified from its own URL. There is nothing to configure.

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  const me = await canvasdrop.me();                  // { id, email, name, avatarUrl, kind }
  const visits = await canvasdrop.kv.increment("visits");
  const room = canvasdrop.realtime.channel("lobby");
  room.subscribe((msg) => console.log(msg.from.name, msg.event, msg.data));
  room.publish("hello", { from: me.name, visits });
</script>
```

The SDK tag is a classic script, so it has run before your module executes;
`type="module"` gives you top-level `await`. On a fresh local instance
(`pnpm dev`, `dev` auth, `http://localhost:3000`) you are already signed in, so
this runs as soon as the canvas has **Backend** switched on.

> A canvas is static until its owner or an editor turns on **Backend** in the
> canvas's **Backend** tab, plus the specific feature (KV, files, AI, realtime).
> A call whose capability is off throws `CapabilityDisabledError`.

## Add it to a canvas

```html
<script src="/sdk/v1.js"></script>
```

The root-relative `src` resolves against the canvas's own origin. The server
serves `{base}/sdk/v1.js` in both URL modes, behind the same sign-in as the
canvas, with `cache-control: public, max-age=3600`. The path is stable and
backward-compatible for the life of v1, so deployed canvases pick up SDK fixes
without a redeploy; a breaking change would ship under a new path.

The script defines exactly one global, `window.canvasdrop`. There is no `cd`
alias, no second name, and no version property on the object.

### How the SDK finds your canvas

`detectContext(window.location)` reads the slug and the API base from the page
URL. You never pass either yourself.

| URL mode | Page URL | Slug | API base |
| --- | --- | --- | --- |
| Path | `https://canvases.example.com/c/quiet-otter-x7k2/` | the segment after `/c/` | the page's own origin |
| Subdomain | `https://quiet-otter-x7k2.canvases.example.com/` | the first hostname label | the protocol plus the remaining labels (port kept, if any) |

Path mode is checked first; any other URL is treated as a subdomain. Every
request goes to `{apiBase}/v1/c/{slug}/…` with `credentials: "include"`, so the
viewer's session cookie rides along. Calls only work from inside the canvas
page: a request from another origin or another canvas is refused
(`CROSS_CANVAS_FORBIDDEN` or `CROSS_SITE_FORBIDDEN`, 403).

### What the viewer can reach

Every call runs the same access check as the canvas itself. A viewer who cannot
open the canvas gets `NotFoundError` (404); a viewer on a password-protected
rung must have passed the gate (`PASSWORD_REQUIRED`, 403). Two limits matter
when you design a canvas:

- **Public link is static-only.** On a `public_link` canvas every primitive is
  refused for everyone except the owner and editors (`STATIC_ONLY`, 403), signed
  in or not.
- **Rate limits.** Default 120 requests per minute per viewer per canvas, and
  10 per minute per viewer for AI (`RATE_LIMITED`, 429, with a `Retry-After`
  header).

## Identity: `me()`

```js
const me = await canvasdrop.me(); // { id, email, name, avatarUrl, kind }
```

`me(): Promise<Me>` returns `{ id: string; email: string; name: string;
avatarUrl: string | null; kind: "member" | "guest" }`. `kind` is `"member"` for
a signed-in org member; `"guest"` is retained for legacy guest sessions. Needs
only the **Backend** master switch.

## KV: `kv` and `kv.user`

```js
// shared (one namespace per canvas)
await canvasdrop.kv.set("votes", 0);
const n = await canvasdrop.kv.get("votes");            // value, or null if absent
const total = await canvasdrop.kv.increment("votes");  // atomic +1; increment("votes", 5) for a step
const { entries, nextCursor } = await canvasdrop.kv.list({ prefix: "p:", limit: 100 });
await canvasdrop.kv.delete("votes");

// per-viewer (scoped to the signed-in user, server-side)
await canvasdrop.kv.user.set("theme", "dark");
const theme = await canvasdrop.kv.user.get("theme");
```

`kv.user` has the same five methods at the `/kv/user` prefix, keyed by the
server-resolved user id; there is no `kv.user.user`.

| Method | Signature | Notes |
| --- | --- | --- |
| `get` | `get<T = unknown>(key: string): Promise<T \| null>` | `null` when the key is absent (the 404 is swallowed) |
| `set` | `set(key: string, value: unknown): Promise<void>` | any JSON value except `null`; `null` is rejected with `INVALID_BODY` (400), delete the key instead |
| `delete` | `delete(key: string): Promise<void>` | idempotent; a missing key is not an error |
| `list` | `list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<KvList>` | `KvList = { entries: Array<{ key: string; value: unknown }>; nextCursor: string \| null }`; `limit` defaults to 100, max 1000; pass `nextCursor` back as `cursor` |
| `increment` | `increment(key: string, by?: number): Promise<number>` | atomic; `by` defaults to `1`; resolves with the new total; `NOT_NUMERIC` (409) if the stored value is not a number |

Limits: keys up to 512 bytes (`KEY_TOO_LARGE`, 413), serialized values up to
64 KiB (`VALUE_TOO_LARGE`, 413), 10,000 shared keys per canvas and 1,000 per
user namespace (`KEY_LIMIT`, 409; updates to existing keys are exempt; both
caps are admin-tunable). `increment` is atomic, so it is safe for concurrent
polls and counters.

## Files: `files`

```js
const f = await canvasdrop.files.upload(input.files[0]); // { id, name, size, url }
const all = await canvasdrop.files.list();               // FileMeta[]
const href = canvasdrop.files.url(f.id);                 // synchronous; use in <img src> or <a href>
await canvasdrop.files.delete(f.id);
```

| Method | Signature | Notes |
| --- | --- | --- |
| `upload` | `upload(file: File): Promise<{ id: string; name: string; size: number; url: string }>` | multipart, field `file`; `url` is absolute (`{apiBase}/v1/c/{slug}/files/{id}/content`); a nameless blob is stored as `upload` |
| `list` | `list(): Promise<FileMeta[]>` | `FileMeta = { id: string; name: string; size: number; mime?: string; createdAt?: number }` |
| `delete` | `delete(id: string): Promise<void>` | `NotFoundError` (404) for an unknown id |
| `url` | `url(id: string): string` | the same content URL as `upload` returns, without a request |

Limits: 25 MiB per file (`FILE_TOO_LARGE`, 413) and 1 GiB per canvas
(`QUOTA_EXCEEDED`, 409). Content is served with `X-Content-Type-Options:
nosniff`; only PNG, JPEG, GIF, WebP, and AVIF render inline. Everything else,
including SVG and HTML, is served as an attachment so an upload can never run
as another viewer on the canvas origin.

## AI: `ai.chat()` and `ai.stream()`

```js
// one-shot: resolves with the full reply
const { text, usage, cost } = await canvasdrop.ai.chat(
  [{ role: "user", content: "Summarize this in one line." }],
  { model: "claude-haiku-4-5", system: "You are terse.", maxTokens: 256 },
);

// streaming: yields text deltas as they arrive
for await (const delta of canvasdrop.ai.stream(
  [{ role: "user", content: "Write a haiku." }],
  { model: "claude-haiku-4-5" },
)) {
  output.textContent += delta;
}
```

```ts
AiMessage     = { role: "user" | "assistant"; content: string }
AiChatOptions = { model: string; system?: string; maxTokens?: number }
AiUsage       = { inputTokens: number; outputTokens: number;
                  cacheCreationInputTokens: number; cacheReadInputTokens: number }
AiResult      = { text: string; usage: AiUsage; cost: number }   // cost in USD
```

- `chat(messages: AiMessage[], options: AiChatOptions): Promise<AiResult>`
- `stream(messages: AiMessage[], options: AiChatOptions): AsyncIterable<string>`

`messages` needs at least one entry and only `user` / `assistant` roles; the
system prompt goes in `options.system`. `options.model` is required and must be
in the instance allow-list (`MODEL_NOT_ALLOWED`, 403, also for an allow-listed
model the server has no price for). `maxTokens` defaults to 1024 and is capped
at 8192. The request body is capped at 256 KiB (`BODY_TOO_LARGE`, 413). There
are no options for temperature, tools, stop sequences, or an `AbortSignal`.

`stream()` yields only text; usage and cost are available from `chat()` alone.
Breaking out of the loop early releases the connection. The provider key lives
on the server; the canvas never sees it, and AI is only on when the operator
has configured one.

Errors before the stream opens arrive as the usual typed errors:
`QuotaExceededError` with `.code === "QUOTA_EXCEEDED"` (a per-viewer daily or
per-canvas monthly spend cap) or `"GUEST_AI_CAP"`, and `GUEST_AI_DISABLED`
(403) for a legacy guest the owner has not opted into AI. Mid-stream, a
disabled capability throws `CapabilityDisabledError`, a quota hit throws
`QuotaExceededError`, and a provider failure throws `CanvasdropError` with
`.code === "AI_UPSTREAM_ERROR"` (502). A stream that ends without a terminal
frame throws `.code === "AI_STREAM_TRUNCATED"` (502).

## Realtime: `realtime.channel()`

```js
const room = canvasdrop.realtime.channel("lobby");

room.subscribe((msg) => {
  // msg: { event: string, data: unknown, from: { id, name } }
  console.log(msg.from.name, msg.event, msg.data);
});
room.onJoin((user) => console.log(user.name, "joined"));
room.onLeave((user) => console.log(user.name, "left"));
room.onPresence((users) => render(users)); // users: { id, name }[]

room.publish("cursor", { x: 12, y: 40 });  // fire-and-forget
const here = await room.presence();        // { id, name }[]

room.unsubscribe(); // drop every message handler, keep the channel
room.close();       // leave the channel for good
```

`realtime.channel(name: string): Channel`. All channels on a page share one
WebSocket to `{apiBase}/v1/c/{slug}/realtime`, opened lazily on the first
`subscribe`, `publish`, or `presence` call.

| Method | Signature | Notes |
| --- | --- | --- |
| `subscribe` | `subscribe(handler: (msg: RealtimeMessage) => void): void` | the handler is the subscription; handlers accumulate; returns nothing |
| `publish` | `publish(event: string, data: unknown): void` | broadcasts to the channel; no acknowledgement |
| `presence` | `presence(): Promise<RealtimeUser[]>` | who is on the channel now |
| `onPresence` | `onPresence(handler: (users: RealtimeUser[]) => void): void` | fires on every presence frame |
| `onJoin` | `onJoin(handler: (user: RealtimeUser) => void): void` | |
| `onLeave` | `onLeave(handler: (user: RealtimeUser) => void): void` | |
| `unsubscribe` | `unsubscribe(): void` | clears all message handlers on this channel |
| `close` | `close(): void` | latches the handle closed; later `publish` throws and `presence` rejects with `CHANNEL_CLOSED`; the socket closes once no channels remain |

`RealtimeMessage = { event: string; data: unknown; from: RealtimeUser }` and
`RealtimeUser = { id: string; name: string }`. `from` is the sender's identity
as resolved by the server, never a client claim. There is no generic
`on(event)`, no `off()`, and `subscribe` does not return an unsubscribe
function.

**Reconnects.** A transient drop reconnects with exponential backoff (500 ms
doubling to a 10 s cap) and re-subscribes every channel. While disconnected,
outbound frames buffer up to 256 entries, dropping the oldest. An in-flight
`presence()` during a drop rejects with `.code === "DISCONNECTED"`.

**Terminal closes** stop reconnecting and become sticky: later `publish()`
calls throw the error and `presence()` rejects with it. They are
`CapabilityDisabledError` (realtime switched off), `NotAuthenticatedError` (the
viewer lost access to the canvas), and `QuotaExceededError` with
`.code === "CONNECTION_LIMIT"` (more than 30 concurrent connections to the
canvas).

**Server limits** are enforced silently: frames up to 16 KiB, channel names up
to 128 bytes, 64 channels per connection, 100 publishes per minute per
connection. A frame over a limit is dropped by the server and the SDK does not
surface it. Realtime is available only when the instance has it switched on
(`CANVAS_DROP_REALTIME`) and the canvas has the `realtime` capability on.

## Publishing canvases from a canvas: `canvases`

A canvas whose owner has switched on the `authoring` capability can publish new
canvases on the viewer's behalf. The viewer becomes the owner of each one. This
is how a builder-style canvas ships what its user made.

```js
const share = await canvasdrop.canvases.publish({
  title: "Q3 plan",
  access: "whole_org",             // "private" | "specific_people" | "whole_org" | "public_link" | "password"
  tags: ["plan"],
  metadata: { sourceApp: "planner", sourceKind: "doc" },
  bundle: zipBlob,                  // Blob | ArrayBuffer; a zip of the static site
});
share.url; // the new canvas's URL

await canvasdrop.canvases.update(share.id, { title: "Q3 plan (final)" });        // settings only
await canvasdrop.canvases.update(share.id, { bundle: newZip });                  // new version, same URL
const mine = await canvasdrop.canvases.list({ sourceApp: "planner" });           // AuthoredCanvas[]
await canvasdrop.canvases.revoke(share.id);                                      // unpublish; stays listed as "revoked"
```

| Method | Signature |
| --- | --- |
| `publish` | `publish(opts: PublishOptions): Promise<AuthoredCanvas>` |
| `update` | `update(id: string, opts: UpdateOptions): Promise<AuthoredCanvas>` |
| `list` | `list(filter?: { sourceApp?: string; sourceKind?: string; tags?: string[] }): Promise<AuthoredCanvas[]>` |
| `revoke` | `revoke(id: string): Promise<void>` |

`PublishOptions = { title: string; slug?: string; tags?: string[]; access?:
ShareAccess; password?: string; expiresAt?: number; metadata?: Record<string,
unknown>; bundle: Blob | ArrayBuffer }`. `UpdateOptions` has the same fields,
all optional, with `password` and `expiresAt` accepting `null` to clear; omit
`bundle` to change settings only. `access: "password"` publishes a public link
behind a password and needs `password`. `AuthoredCanvas` carries `id`, `url`,
`title`, `tags`, `access`, `hasPassword`, `status` (`"live" | "expired" |
"revoked" | "private"`), `createdAt`, `updatedAt`, `expiresAt`, `revokedAt`,
`createdBy`, `version`, `bundleUpdatedAt`, `sourceApp`, `sourceKind`, and
`metadata`.

Only org members can author; a legacy guest gets `NotAuthenticatedError`.
Publishing is metered per viewer (`QuotaExceededError`, `.code ===
"QUOTA_EXCEEDED"`). If the canvas was created but its deploy or share settings
failed, `publish` throws `PublishFailedError` with the new canvas's `.id` so you
can `update` or `revoke` it. `update` on a revoked share without a bundle throws
`.code === "SHARE_REVOKED"` (409); include a bundle to publish it again. Whether
a viewer may publish a public link follows the same instance and admin rules as
the dashboard (`PUBLIC_LINKS_DISABLED`, `PUBLIC_NOT_ALLOWED`, 403).

## Errors

Every failure throws an error extending `CanvasdropError`, which carries a
stable string `.code`, the HTTP `.status`, and, when the server sent one, a
remediation `.hint`. Five subclasses exist:

| Class | `.code` | `.status` | When |
| --- | --- | --- | --- |
| `NotAuthenticatedError` | `NOT_AUTHENTICATED` | 401 | the viewer is not signed in, or a guest called `canvases.*` |
| `CapabilityDisabledError` | `CAPABILITY_DISABLED` | 403 | Backend, or the specific feature, is off for this canvas; the message is the server's `.hint` when it sent one, otherwise it names the capability |
| `NotFoundError` | `NOT_FOUND` | 404 | the key, file, or canvas does not exist, or the viewer has no access (any 404) |
| `QuotaExceededError` | `QUOTA_EXCEEDED`, `GUEST_AI_CAP`, `KEY_LIMIT`, `CONNECTION_LIMIT`, or any 413 code (`KEY_TOO_LARGE`, `VALUE_TOO_LARGE`, `FILE_TOO_LARGE`, `BODY_TOO_LARGE`) | 429, 409, or 413 | a spend, rate, count, or size limit |
| `PublishFailedError` | `PUBLISH_FAILED` | 502 | `canvases.publish` created the canvas but its deploy or share settings failed; `.id` is the new canvas |

The mapping is by precedence: any 401 → `NotAuthenticatedError`; a 403 with
code `CAPABILITY_DISABLED` → `CapabilityDisabledError`; any 404 →
`NotFoundError`; code `PUBLISH_FAILED` → `PublishFailedError`; codes
`QUOTA_EXCEEDED` / `GUEST_AI_CAP` / `KEY_LIMIT` or any 413 →
`QuotaExceededError`. Everything else is a base `CanvasdropError` whose `.code`
is the wire code, so branch on `err.code` rather than on class:

| `.code` | `.status` | Meaning |
| --- | --- | --- |
| `PASSWORD_REQUIRED` | 403 | the canvas is password-protected and the viewer has not passed the gate |
| `STATIC_ONLY` | 403 | public-link canvas; primitives are refused for non-owners |
| `DISABLED` | 403 | an administrator disabled the canvas |
| `MODEL_NOT_ALLOWED` | 403 | the AI model is not in the allow-list |
| `GUEST_AI_DISABLED` | 403 | AI is off for a legacy guest viewer |
| `CROSS_CANVAS_FORBIDDEN`, `CROSS_SITE_FORBIDDEN` | 403 | the call did not come from this canvas's page |
| `INVALID_BODY` | 400 | the request body failed validation (for example, `kv.set(key, null)`) |
| `NOT_NUMERIC` | 409 | `increment` on a non-numeric value |
| `SHARE_REVOKED` | 409 | `canvases.update` on a revoked share without a bundle |
| `RATE_LIMITED` | 429 | the per-viewer request rate limit; check `Retry-After` |
| `AI_UPSTREAM_ERROR` | 502 | the AI provider returned an error |
| `AI_STREAM_TRUNCATED` | 502 | the AI stream ended without a terminal frame |
| `REQUEST_FAILED` | any | a failure without a more specific code |

A few codes are raised by the SDK itself, with no HTTP round-trip:
`DISCONNECTED` and `CHANNEL_CLOSED` (realtime, status 0), `NO_STREAM` and
`MALFORMED_FRAME` (a missing or unparseable AI stream, 502), and `AI_ERROR` (an
AI error frame with no code, 502).

```js
try {
  await canvasdrop.kv.increment("votes");
} catch (err) {
  if (err.code === "CAPABILITY_DISABLED") {
    // ask the owner to turn on KV in the Backend tab; err.hint may say how
  } else if (err.code === "NOT_NUMERIC") {
    // the existing value is not a number
  } else {
    throw err;
  }
}
```

## Importing as a module

The served script is the same client that the `@canvas-drop/sdk` package
exports, with the context detected for you. The package exports `createClient`,
`detectContext`, `SDK_VERSION` (the string `"1"`), `ERROR_CODES` (the 23 wire
codes with status and summary), `errorFromResponse`, the six error classes for
`instanceof` checks, and every interface above (`CanvasdropClient`, `Me`,
`KvNamespace`, `KvList`, `FileMeta`, `AiMessage`, `AiChatOptions`, `AiUsage`,
`AiResult`, `Channel`, `RealtimeMessage`, `RealtimeUser`, `PublishOptions`,
`UpdateOptions`, `AuthoredCanvas`).

```ts
import { createClient, detectContext } from "@canvas-drop/sdk";

const canvasdrop = createClient({ context: detectContext(window.location) });
```

`createClient` also accepts `fetch`, `WebSocketImpl`, and `reconnectBaseMs`
(default 500) for tests and non-browser hosts.

An agent-oriented quick reference for the whole surface is served at
`{base}/llms.txt`; the served docs site under `{base}/docs` has a page per
primitive.
