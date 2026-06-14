# Realtime

`canvasdrop.realtime` is ephemeral pub/sub with presence — for live cursors,
reactions, and collaborative demos. Messages are not persisted; they fan out to
whoever is connected to a channel right now.

```js
const channel = canvasdrop.realtime.channel("room-1");

channel.subscribe((msg) => {
  console.log(msg.event, msg.data);
});

channel.publish("reaction", { emoji: "🎉" });

const who = await channel.presence(); // RealtimeUser[] currently in the channel

channel.unsubscribe();
channel.close(); // closes the shared socket when no channels remain
```

## Notes

- Channels share one WebSocket per canvas; `close()` releases it when the last
  channel goes away.
- Realtime is bounded: during an outage a high-frequency publisher's buffer is
  capped rather than growing without limit.
- A disabled capability surfaces as `CapabilityDisabledError`.

See [error codes](/docs/api/errors) and the
[Runtime API](/docs/api/runtime-api).
