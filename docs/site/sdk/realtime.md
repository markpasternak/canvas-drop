# Realtime

Add live cursors, reactions, or a shared room to a canvas with
`canvasdrop.realtime`: ephemeral pub/sub plus presence. Messages are not
persisted; they fan out to whoever is connected to a channel right now.
Identity on every message and in the presence list comes from the server-side
session, never the client, so `from.name` and the presence list are always
trustworthy.

No keys, no setup: `canvasdrop` is already on `window` in any canvas, and it
connects to the right canvas automatically.

```js
const channel = canvasdrop.realtime.channel("room-1");

// Receive published messages.
channel.subscribe((msg) => {
  // msg = { event, data, from: { id, name } }
  console.log(msg.from.name, msg.event, msg.data);
});

// Broadcast to everyone subscribed to this channel.
channel.publish("reaction", { emoji: "🎉" });

// Presence: who is in the channel right now.
const users = await channel.presence(); // [{ id, name }, ...]

channel.onPresence((users) => {/* full list changed */});
channel.onJoin((user) => console.log(user.name, "joined"));
channel.onLeave((user) => console.log(user.name, "left"));

channel.unsubscribe(); // stop receiving messages on this channel
channel.close();        // closes the shared socket when no channels remain
```

## `Channel` methods

| Method | Signature | What it does |
| --- | --- | --- |
| `publish` | `publish(event: string, data: unknown): void` | Broadcast `{ event, data }` to the channel. The server attaches `from`. |
| `subscribe` | `subscribe(handler: (msg: RealtimeMessage) => void): void` | Register a message handler and join the channel. |
| `unsubscribe` | `unsubscribe(): void` | Stop receiving messages on this channel. |
| `presence` | `presence(): Promise<RealtimeUser[]>` | Resolve with the current presence list. |
| `onPresence` | `onPresence(handler: (users: RealtimeUser[]) => void): void` | Fire whenever the presence list changes. |
| `onJoin` | `onJoin(handler: (user: RealtimeUser) => void): void` | Fire when a user joins. |
| `onLeave` | `onLeave(handler: (user: RealtimeUser) => void): void` | Fire when a user leaves. |
| `close` | `close(): void` | Drop this channel; closes the shared socket when none remain. |

There is no generic `on(event, handler)` — use the specific listeners above.

Shapes:

```ts
type RealtimeUser = { id: string; name: string };
type RealtimeMessage = { event: string; data: unknown; from: RealtimeUser };
```

## How the connection works

- All channels on a canvas share **one** WebSocket, at
  `wss://{base}/v1/c/{slug}/realtime` (`ws://` over plain HTTP). The SDK derives
  the host and slug from the page, so you never construct the URL yourself.
- The socket auto-reconnects with capped exponential backoff (default base
  `500` ms, capped at `10000` ms).
- `close()` on the last open channel tears the socket down.

## Limits and errors

Per-canvas limits enforced by the server: **30** concurrent connections, **100**
messages per minute, **16 KB** per frame. For these and other recoverable
problems the server replies with an `{ type: "error", code }` frame and keeps
the socket open: `RATE_LIMITED` (over 100/min), `MESSAGE_TOO_LARGE` (over 16 KB),
`INVALID_FRAME` (unparseable JSON), `UNKNOWN_FRAME` (unrecognized type). The
terminal failures below close the socket instead:

- **Capability off:** if `realtime` is disabled for the canvas, the server sends
  an in-band `{ type: "error", code: "CAPABILITY_DISABLED" }` frame and closes the
  socket. After that, `publish()` throws and `presence()` rejects with a
  `CapabilityDisabledError` (`code: "CAPABILITY_DISABLED"`).
- **Connection limit:** exceeding 30 concurrent connections surfaces as a
  `QuotaExceededError` (`code: "CONNECTION_LIMIT"`).
- **Not signed in:** an expired or missing session surfaces as a
  `NotAuthenticatedError` (`code: "NOT_AUTHENTICATED"`).

These map to WebSocket close codes `4403` (capability), `4429` (connection
limit), and `4401` (auth); those closes are terminal, so the SDK does not
reconnect after them.

See [error codes](/docs/api/errors) and the
[Runtime API](/docs/api/runtime-api).
