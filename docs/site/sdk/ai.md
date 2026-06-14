# AI

`canvasdrop.ai` runs model calls **server-side** so the provider key never lives
in the canvas. The owner enables the AI capability, and the operator configures
the provider and per-user/per-canvas spend limits.

## Complete

Accumulate a full response:

```js
const { text, usage } = await canvasdrop.ai.complete(
  [{ role: "user", content: "Summarise this poll result in one line." }],
  { model: "<configured-model>" },
);
```

## Stream

Iterate tokens as they arrive:

```js
for await (const chunk of canvasdrop.ai.stream(messages, { model })) {
  output.textContent += chunk;
}
```

## Limits and errors

- Spend is metered per user and per canvas; exceeding a budget throws
  `QuotaExceededError` (`code: "QUOTA_EXCEEDED"`).
- If a stream ends before completion you get `AI_STREAM_TRUNCATED`.
- A disabled capability throws `CapabilityDisabledError`.

See [error codes](/docs/api/errors) and the
[Runtime API](/docs/api/runtime-api) for the underlying endpoint.
