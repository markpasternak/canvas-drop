# Realtime

Add live cursors, reactions, or a shared room to a canvas with
`canvasdrop.realtime`: ephemeral pub/sub plus presence over named channels.
Messages fan out to whoever is subscribed to the channel at that moment and are
never stored; put anything that must survive a reload in [KV](/docs/sdk/kv).
The `from` on every message and every entry in the presence list come from the
viewer's server-side session, never from the page, so names are trustworthy.

`canvasdrop` is already on `window` in any served canvas (see the
[SDK overview](/docs/sdk/overview)) and connects to the right canvas from its
URL. Realtime is on as soon as the canvas has its backend switched on, unless
the owner turned the realtime toggle off or an administrator switched realtime
off for the whole instance (the admin setting overrides `CANVAS_DROP_REALTIME`,
which defaults to `on`). See [Capabilities](/docs/authoring/capabilities).

```js
const room = canvasdrop.realtime.channel("room-1");

// Receive what anyone on the channel publishes, including yourself.
room.subscribe((msg) => {
  // msg = { event, data, from: { id, name } }
  console.log(msg.from.name, msg.event, msg.data);
});

// Broadcast to everyone subscribed right now. Fire-and-forget.
room.publish("cursor", { x: 120, y: 48 });

// Who is in the channel right now.
const users = await room.presence(); // [{ id, name }, ...]

room.onJoin((user) => console.log(user.name, "joined"));
room.onLeave((user) => console.log(user.name, "left"));

room.unsubscribe(); // stop receiving messages; the handle stays usable
room.close();       // done with this channel; the socket closes when none remain
```

## `Channel` methods

`canvasdrop.realtime.channel(name)` returns a `Channel`. Signatures as declared
in the SDK:

| Method | Signature | What it does |
| --- | --- | --- |
| `publish` | `publish(event: string, data: unknown): void` | Send `{ event, data }` to every current subscriber. Returns nothing; there is no delivery receipt. You do not need to be subscribed to publish. |
| `subscribe` | `subscribe(handler: (msg: RealtimeMessage) => void): void` | Join the channel and run `handler` for each message. Calling it again adds another handler; it does not return an unsubscribe function. |
| `unsubscribe` | `unsubscribe(): void` | Leave the channel and drop every message handler. `onPresence`, `onJoin`, and `onLeave` handlers stay registered. |
| `presence` | `presence(): Promise<RealtimeUser[]>` | Resolve with the users subscribed to the channel right now. Works whether or not you are subscribed. |
| `onPresence` | `onPresence(handler: (users: RealtimeUser[]) => void): void` | Run `handler` each time the server sends a full roster (see below). |
| `onJoin` | `onJoin(handler: (user: RealtimeUser) => void): void` | Run `handler` when another user's first connection joins the channel. |
| `onLeave` | `onLeave(handler: (user: RealtimeUser) => void): void` | Run `handler` when another user's last connection leaves the channel. |
| `close` | `close(): void` | Retire this handle: it leaves the channel, and the shared socket closes once no channels remain. `publish` and `presence` on a closed handle fail with `CHANNEL_CLOSED`. |

There is no generic `on(event, handler)`, `off`, or `once`; the four listener
hooks above are the whole surface.

```ts
type RealtimeUser = { id: string; name: string };
type RealtimeMessage = { event: string; data: unknown; from: RealtimeUser };
```

## What presence and messages mean

- A message reaches every connection subscribed to the channel, the sender's
  included. If you subscribe and publish from the same page, your own handler
  runs for your own messages.
- Presence is the list of distinct users subscribed to the channel. A person
  with two tabs open appears once.
- `onJoin` fires for the other users when a person's first connection
  subscribes; `onLeave` fires when their last connection unsubscribes, closes,
  or drops. You never receive your own join or leave.
- `onPresence` fires when the server sends a roster: right after your own
  `subscribe` (including the re-subscribe after a reconnect) and after every
  `presence()` call. It does not fire when someone else joins or leaves. To keep
  a live roster, apply `onJoin` and `onLeave` to the list you got from
  `presence()`, or call `presence()` again.
- Channels live in the server process's memory. Nothing is persisted, and a
  channel is only reachable within its own canvas.

## How the connection works

- All channels on a canvas share one WebSocket, at
  `{base}/v1/c/{slug}/realtime` over `wss://` (`ws://` when the instance runs on
  plain HTTP). It is the same host the SDK uses for every other primitive, so
  you never construct the URL yourself.
- The socket opens lazily, on the first `subscribe()` or `presence()` on any
  channel. Frames sent before the socket is open are buffered and flushed once
  it connects; the buffer keeps the most recent 256 frames and drops the oldest
  beyond that. A page that only ever calls `publish()` should still subscribe
  (or call `presence()`) once so the socket comes up.
- After a transient drop the SDK reconnects with exponential backoff, starting
  at 500 ms and capped at 10 s, and re-subscribes every channel on open. Any
  `presence()` in flight at the moment of the drop rejects with a
  `CanvasdropError` (`code: "DISCONNECTED"`, `status: 0`) rather than hanging;
  call it again.
- A refused upgrade (the viewer is signed out, has not passed the password
  gate, or is on a Public link canvas, which is static-only) never becomes a
  socket. The browser reports it as an ordinary close, so the SDK keeps
  retrying, backing off to the 10 s cap.
- `close()` on the last open channel tears the socket down with a normal close.

## Limits and errors

Limits enforced by the server:

| Limit | Value | When exceeded |
| --- | --- | --- |
| Connections per canvas | 30 | Close `4429` (terminal) |
| Publishes per connection | 100 per rolling minute | Error frame `RATE_LIMITED`; the publish is dropped |
| Frame size (whole JSON frame) | 16 KiB | Error frame `MESSAGE_TOO_LARGE`; the frame is dropped |
| Channel name | 128 bytes | Error frame `CHANNEL_NAME_TOO_LARGE` |
| Channels per connection | 64 | Error frame `CHANNEL_LIMIT` |

The error frames (`RATE_LIMITED`, `MESSAGE_TOO_LARGE`, `CHANNEL_NAME_TOO_LARGE`,
`CHANNEL_LIMIT`, `INVALID_FRAME`, `UNKNOWN_FRAME`) keep the socket open, and the
SDK does not surface them to your code: a rejected publish is dropped silently.
Keep high-frequency publishers such as cursors under 100 sends a minute per
tab, and keep payloads small.

Three failures are terminal. The SDK stops reconnecting, rejects any pending
`presence()`, and makes every later `publish()` throw and `presence()` reject
with the same typed error:

| Condition | Close code | Error |
| --- | --- | --- |
| Realtime is off for the canvas (owner toggle or the instance switch). When you connect while it is already off, the server sends one `{ type: "error", code: "CAPABILITY_DISABLED" }` frame before closing. | `4403` | `CapabilityDisabledError` (`code: "CAPABILITY_DISABLED"`) |
| The session lost access: signed out, the canvas was deleted, archived, disabled, or moved to a rung the viewer is not on, a password was set, or the account was deactivated. The server re-checks live sockets on every access-changing change and on a periodic heartbeat. | `4401` | `NotAuthenticatedError` (`code: "NOT_AUTHENTICATED"`) |
| The canvas already has 30 open connections. | `4429` | `QuotaExceededError` (`code: "CONNECTION_LIMIT"`, `status: 429`) |

Wrap `presence()` in a `try`/`catch` and branch on `err.code` to show a "live
features are off" state instead of failing the whole page; the rest of the
canvas keeps working without the socket.

See the [error codes reference](/docs/api/errors) for the full code table and
the [Runtime API](/docs/api/runtime-api) for the wire protocol behind the SDK.
