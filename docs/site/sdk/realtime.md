# Realtime

Add live cursors, reactions, or a shared room to a canvas with
`canvasdrop.realtime`: ephemeral pub/sub plus presence over named channels. By
the end of this page you can publish to a channel, receive what others publish,
read who is present, and handle the three ways a socket ends for good. Messages
fan out to whoever is subscribed to the channel at that moment and are never
stored; put anything that must survive a reload in [KV](/docs/sdk/kv).

`canvasdrop` is already on `window` in any served canvas (see the
[SDK overview](/docs/sdk/overview)) and connects to the right canvas from its
URL. The `from` on every message and every entry in the presence list come from
the viewer's server-side session, never from the page, so names are trustworthy.

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

## When realtime is on

Realtime works when all three switches are on. A new canvas ships with the
backend off, so the first step is usually turning that on.

| Switch | Default | Who sets it |
| --- | --- | --- |
| The canvas's backend (master switch) | off | The owner or an editor, in the canvas's Backend tab or with the `set_capabilities` MCP tool |
| The canvas's `realtime` flag | on | Same place |
| The instance switch `CANVAS_DROP_REALTIME` | `on` | The operator, in the server environment. The admin panel shows it read-only. |

When any of the three is off, the server closes the socket with code `4403`
and the SDK raises `CapabilityDisabledError` (see
[Limits and errors](#limits-and-errors)). The rest of the canvas keeps working.
Details in [Capabilities](/docs/authoring/capabilities).

## `Channel` methods

`canvasdrop.realtime.channel(name)` returns a `Channel`. Signatures as declared
in the SDK:

| Method | Signature | What it does |
| --- | --- | --- |
| `publish` | `publish(event: string, data: unknown): void` | Send `{ event, data }` to every current subscriber. Returns nothing; there is no delivery receipt. You do not need to be subscribed to publish, but see [How the connection works](#how-the-connection-works) for when the socket opens. |
| `subscribe` | `subscribe(handler: (msg: RealtimeMessage) => void): void` | Join the channel and run `handler` for each message. Calling it again adds another handler; it does not return an unsubscribe function. |
| `unsubscribe` | `unsubscribe(): void` | Leave the channel and drop every message handler. `onPresence`, `onJoin`, and `onLeave` handlers stay registered, but no join or leave reaches you until you subscribe again. |
| `presence` | `presence(): Promise<RealtimeUser[]>` | Resolve with the users subscribed to the channel right now. Works whether or not you are subscribed. |
| `onPresence` | `onPresence(handler: (users: RealtimeUser[]) => void): void` | Run `handler` each time the server sends a full roster (see below). |
| `onJoin` | `onJoin(handler: (user: RealtimeUser) => void): void` | Run `handler` when another user's first connection joins the channel. |
| `onLeave` | `onLeave(handler: (user: RealtimeUser) => void): void` | Run `handler` when another user's last connection leaves the channel. |
| `close` | `close(): void` | Retire this handle: it leaves the channel, and the shared socket closes once no channels remain. `publish` and `presence` on a closed handle fail with a `CanvasdropError` (`code: "CHANNEL_CLOSED"`, `status: 0`). |

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
- `onPresence` fires when the server sends a roster: right after your
  `subscribe` (including the re-subscribe after a reconnect) and after every
  `presence()` call. It does not fire when someone else joins or leaves. To keep
  a live roster, apply `onJoin` and `onLeave` to the list you got from
  `presence()`, or call `presence()` again.
- Channels live in the server process's memory. Nothing is persisted, and a
  channel is only reachable within its own canvas: a channel name is a key
  inside the canvas the socket was opened for, never across canvases.

## How the connection works

- All channels on a canvas share one WebSocket, at
  `{base}/v1/c/{slug}/realtime` over `wss://` (`ws://` when the instance runs on
  plain HTTP). It is the same host the SDK uses for every other primitive, so
  you never construct the URL yourself. Each accepted connection counts once in
  the canvas's usage stats (realtime connects).
- The socket opens on the first `subscribe()` or `presence()` on any channel.
  `publish()` on its own does not open it on a page where no channel has been
  subscribed, asked for presence, or given a listener; those frames wait in the
  buffer and nothing connects. Subscribe once (or call `presence()`) before you
  publish.
- Frames sent while the socket is not open (`publish`, `presence`,
  `unsubscribe`) are buffered and flushed once it connects; the buffer keeps the
  most recent 256 frames and drops the oldest beyond that. Subscriptions are
  not buffered: every subscribed channel is re-sent from the client's state
  each time the socket opens.
- After a transient drop the SDK reconnects with exponential backoff, starting
  at 500 ms, doubling, and capped at 10 s. On open it re-subscribes every
  subscribed channel, then flushes the buffer. Any `presence()` in flight at
  the moment of the drop rejects with a `CanvasdropError` (`code:
  "DISCONNECTED"`, `status: 0`) rather than hanging; call it again.
- A refused upgrade never becomes a socket: the viewer is signed out, has not
  passed the password gate, cannot see the canvas at its current rung, or is on
  a Public link canvas (static-only, every primitive refused). The browser
  reports each attempt as an ordinary close, so the SDK keeps retrying, backing
  off to the 10 s cap, and no typed error reaches your code.
- `close()` on the last open channel tears the socket down with a normal close.
  Signing out of the dashboard does not by itself close a socket that is
  already open; the next reconnect attempt is what gets refused.

## Limits and errors

Limits enforced by the server:

| Limit | Value | When exceeded |
| --- | --- | --- |
| Connections per canvas | 30 | Close `4429` (terminal) |
| Publishes per connection | 100 per rolling minute | Error frame `RATE_LIMITED`; the publish is dropped |
| Frame size (whole JSON frame) | 16 KiB | Error frame `MESSAGE_TOO_LARGE`; the frame is dropped |
| Channel name | 128 bytes | Error frame `CHANNEL_NAME_TOO_LARGE`; the frame is dropped |
| Channels per connection | 64 | Error frame `CHANNEL_LIMIT`; the subscribe is dropped |

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
| Realtime is off for the canvas (any of the three switches above). When you connect while it is already off, the server sends one `{ type: "error", code: "CAPABILITY_DISABLED", capability: "realtime" }` frame before closing. When it is switched off while you are connected, the socket is closed on the next re-check. | `4403` | `CapabilityDisabledError` (`code: "CAPABILITY_DISABLED"`, `status: 403`) |
| The connection lost access: the canvas was deleted, archived, disabled, or unpublished; it moved to a rung the viewer is not on; the viewer was removed from the people list, a team, or the editor role; the share expired; a password was set (owner and editors are exempt); or the account was blocked or deleted. The server re-checks live sockets on every access-changing change and on a heartbeat every 60 s. | `4401` | `NotAuthenticatedError` (`code: "NOT_AUTHENTICATED"`, `status: 401`) |
| The canvas already has 30 open connections. | `4429` | `QuotaExceededError` (`code: "CONNECTION_LIMIT"`, `status: 429`) |

Wrap `presence()` in a `try`/`catch` and branch on `err.code` to show a "live
features are off" state instead of failing the whole page; the rest of the
canvas keeps working without the socket.

```js
try {
  await room.presence();
} catch (err) {
  if (err.code === "CAPABILITY_DISABLED") showBanner("Live features are off for this canvas.");
  else if (err.code === "CONNECTION_LIMIT") showBanner("This room is full right now.");
  else if (err.code === "DISCONNECTED") retryLater();
  else throw err;
}
```

See the [error codes reference](/docs/api/errors) for the full code table and
the [Runtime API](/docs/api/runtime-api) for the wire protocol behind the SDK.
