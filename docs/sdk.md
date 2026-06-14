# Canvas SDK (`canvasdrop`)

The browser SDK gives a canvas backend capability — key–value storage, file
storage, AI chat, realtime channels, and the signed-in viewer's identity — with
**no build step and no secrets in the canvas**. Identity comes from the signed-in
session; the canvas is identified by its own URL.

> The canvas owner must turn on **Backend** (and the specific feature) in the
> canvas's **Backend** tab. A method whose capability is off throws a
> `CapabilityDisabledError`.

## Add it to a canvas

```html
<script src="/sdk/v1.js"></script>
```

That defines the global `window.canvasdrop`. The SDK auto-detects the canvas slug
and the API base from the page's location (path mode `/c/{slug}/…` or subdomain
`{slug}.{host}`), and sends every request with the session cookie
(`credentials: "include"`). All requests hit `/v1/c/{slug}/…` under the detected
API base.

The stable `/sdk/v1.js` path is **additive and backward-compatible within v1**, so
pointing your `<script>` at it means you receive fixes (including security
patches) without redeploying. A breaking change would ship under a new path
(`/sdk/v2.js`).

## Identity

```js
const me = await canvasdrop.me(); // { id, email, name, avatarUrl }
```

`avatarUrl` is `string | null`.

## Key–value storage

```js
// shared (canvas-global)
await canvasdrop.kv.set("votes", 0);
const n = await canvasdrop.kv.get("votes");           // value, or null if absent
const total = await canvasdrop.kv.increment("votes"); // atomic +1; pass a step: increment("votes", 5)
await canvasdrop.kv.delete("votes");
const { entries, nextCursor } = await canvasdrop.kv.list({ prefix: "p:", limit: 100 });

// per-viewer (auto-scoped to the signed-in user)
await canvasdrop.kv.user.set("pref", "dark");
const pref = await canvasdrop.kv.user.get("pref");
```

`get<T>(key)` returns the stored value or `null` if the key is absent.
`list(opts?)` accepts `{ prefix?, cursor?, limit? }` and returns
`{ entries: Array<{ key, value }>, nextCursor: string | null }`. `increment(key, by?)`
defaults `by` to `1` and returns the new number; it throws an error with
`.code === "NOT_NUMERIC"` (409) if the existing value isn't numeric. `kv.user` exposes the same five methods,
scoped to the signed-in user.

Limits: values up to 64 KiB, keys up to 512 bytes, 10,000 shared keys per canvas
(1,000 per user namespace; admin-tunable). `increment` is atomic — safe for
concurrent polls and votes.

## File storage

```js
const f = await canvasdrop.files.upload(input.files[0]); // { id, name, size, url }
const all = await canvasdrop.files.list();               // FileMeta[]: { id, name, size, mime?, createdAt? }
const href = canvasdrop.files.url(f.id); // synchronous content URL (use in <img>, <a>)
await canvasdrop.files.delete(f.id);
```

`upload(file)` takes a `File` and returns `{ id, name, size, url }`, where `url`
is the absolute `/v1/c/{slug}/files/{id}/content` path. `url(id)` returns the same
string synchronously. Content is served with `X-Content-Type-Options: nosniff`;
uploaded HTML/SVG is served as an attachment, never rendered inline (so it can't
run as another viewer).

## AI

```js
// one-shot — resolves with the full reply
const { text, usage, cost } = await canvasdrop.ai.chat(
  [{ role: "user", content: "Summarize this in one line." }],
  { model: "claude-haiku-4-5", system: "You are terse.", maxTokens: 256 },
);

// streaming — yields text deltas as they arrive
for await (const delta of canvasdrop.ai.stream(
  [{ role: "user", content: "Write a haiku." }],
  { model: "claude-haiku-4-5" },
)) {
  output.textContent += delta;
}
```

Messages are `{ role: "user" | "assistant", content: string }[]` (at least one).
The system prompt is passed via `options.system`, **not** as a message role.
`options.model` is **required**; `maxTokens` defaults to 1024 (hard max 8192).
`chat` resolves to `{ text, usage: { inputTokens, outputTokens }, cost }`; `stream`
is an async iterable of text deltas. Provider keys are server-side only — never in
the canvas.

Both throw a base `CanvasdropError` with `.code === "MODEL_NOT_ALLOWED"` (status
403) if the model isn't in the instance allow-list, `QuotaExceededError` (429) on
a spend cap, and
`AI_STREAM_TRUNCATED` (502) if the stream ends before completion.

## Realtime

```js
const room = canvasdrop.realtime.channel("lobby");

room.subscribe((msg) => {
  // msg: { event, data, from: { id, name } }
  console.log(msg.from.name, msg.event, msg.data);
});
room.onJoin((user) => console.log(user.name, "joined"));
room.onLeave((user) => console.log(user.name, "left"));
room.onPresence((users) => render(users)); // users: { id, name }[]

room.publish("cursor", { x: 12, y: 40 });
const here = await room.presence(); // { id, name }[]

room.unsubscribe();
room.close();
```

`realtime.channel(name)` returns a `Channel` over one shared, auto-reconnecting
WebSocket per canvas. `subscribe(handler)` takes the message handler (it is the
subscription itself), `publish(event, data)` broadcasts to the channel,
`presence()` resolves with the current member list, and `onJoin` / `onLeave` /
`onPresence` register the corresponding listeners. `from` on each message is the
sender's server-resolved identity. Realtime is available only when the instance
has WebSocket support wired and the `realtime` capability is on.

## Errors

Every failure throws a typed error extending `CanvasdropError` (each carries a
stable `.code` and `.status`). Four subclasses exist:

| Error | `.code` | When |
|-------|---------|------|
| `CapabilityDisabledError` | `CAPABILITY_DISABLED` | the feature (or Backend) is off for this canvas (403) |
| `QuotaExceededError` | `QUOTA_EXCEEDED` (or `CONNECTION_LIMIT`) | a value/file too large, key-count limit, or spend/rate/connection quota hit (409/413/429) |
| `NotFoundError` | `NOT_FOUND` | the key/file doesn't exist (404) |
| `NotAuthenticatedError` | `NOT_AUTHENTICATED` | the viewer isn't signed in (401) |

Other failures throw the base `CanvasdropError` carrying the wire code directly —
e.g. `INVALID_BODY` (400), `KEY_TOO_LARGE` / `VALUE_TOO_LARGE` / `FILE_TOO_LARGE`
(413), `KEY_LIMIT` (409), `NOT_NUMERIC` (409), `MODEL_NOT_ALLOWED` (403),
`AI_STREAM_TRUNCATED` / `AI_UPSTREAM_ERROR` (502), or `REQUEST_FAILED`. Branch on
`err.code`:

```js
try {
  await canvasdrop.kv.increment("votes");
} catch (err) {
  if (err.code === "CAPABILITY_DISABLED") {
    // ask the owner to enable KV in the Backend tab
  } else if (err.code === "NOT_NUMERIC") {
    // the existing value isn't a number
  } else {
    throw err;
  }
}
```

(If you import the SDK as a module instead of the global script, the four error
classes and all types are exported for `instanceof` checks, and
`import { SDK_VERSION } from "@canvas-drop/sdk"` is the string `"1"`.)

An agent-oriented quick reference is served at `/llms.txt`.
