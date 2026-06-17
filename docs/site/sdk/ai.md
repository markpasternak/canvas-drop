# AI

Call a language model from your canvas without holding a provider key. The
`canvasdrop.ai` primitive posts your messages to the server, which runs the
model call server-side and streams the result back. The provider key stays on
the server: never put one in canvas code.

```js
const { text, usage, cost } = await canvasdrop.ai.chat(
  [{ role: "user", content: "Summarise this poll result in one line." }],
  { model: "claude-haiku-4-5" },
);
// text:  the model's reply (string)
// usage: { inputTokens, outputTokens }
// cost:  number (USD)
```

Two entry points, both backed by `POST /v1/c/<slug>/ai/chat`:

- `chat(messages, options)` — await the full response.
- `stream(messages, options)` — iterate text as it arrives.

`messages` must hold at least one message. `options.model` is **required** and
must be on the instance's [model allowlist](#models).

## Chat

`chat(messages, options)` accumulates every text delta and resolves once with
`{ text, usage, cost }` (the snippet above). It throws if the model is not
allowlisted, a quota is exceeded, or the stream ends early — see
[Limits and errors](#limits-and-errors).

## Stream

Iterate text deltas as they arrive:

```js
for await (const delta of canvasdrop.ai.stream(messages, {
  model: "claude-haiku-4-5",
})) {
  output.textContent += delta;
}
```

## Messages and options

```ts
type AiMessage = { role: "user" | "assistant"; content: string };

type AiChatOptions = {
  model: string;       // required; must be allowlisted
  system?: string;     // system prompt (not a message role)
  maxTokens?: number;  // > 0; default 1024, hard max 8192
};
```

There is no `"system"` message role. Pass the system prompt via
`options.system`:

```js
await canvasdrop.ai.chat(messages, {
  model: "claude-sonnet-4-6",
  system: "You are a terse assistant. Answer in one sentence.",
  maxTokens: 256,
});
```

## Models

The operator configures the allowlist with `CANVAS_DROP_AI_MODELS` (a CSV).
The default is `claude-haiku-4-5,claude-sonnet-4-6,claude-opus-4-8`. Asking for
a model that is not on the list — or one that is listed but has no price the
server can meter against — throws with `code: "MODEL_NOT_ALLOWED"` (HTTP 403).
Use the exact model id as configured.

## Limits and errors

- **Spend quotas.** AI spend is capped per user per day
  (`CANVAS_DROP_AI_USER_DAILY_USD`, default `5`) and per canvas per month
  (`CANVAS_DROP_AI_CANVAS_MONTHLY_USD`, default `50`). Exceeding a cap throws
  `QuotaExceededError` (`code: "QUOTA_EXCEEDED"`, HTTP 429).
- **Token limit.** `maxTokens` defaults to `1024` and is clamped to a hard max
  of `8192`.
- **Capability off.** If the `ai` capability is disabled for the canvas — or no
  provider key is configured on the instance — calls throw
  `CapabilityDisabledError` (`code: "CAPABILITY_DISABLED"`, HTTP 403).
- **Guests.** When an invited guest (not an org member) calls AI, the owner must
  have opted the canvas in, or the call throws `code: "GUEST_AI_DISABLED"`
  (HTTP 403). Guest spend has its own cap; hitting it throws
  `QuotaExceededError` with `code: "GUEST_AI_CAP"` (HTTP 429).
- **Stream truncated.** If the stream ends before a terminal frame arrives,
  both `chat` and `stream` throw with `code: "AI_STREAM_TRUNCATED"` (HTTP 502).
- **Upstream error.** A provider failure mid-stream surfaces as
  `code: "AI_UPSTREAM_ERROR"` (HTTP 502).

See [error codes](/docs/api/errors) and the
[Runtime API](/docs/api/runtime-api) for the underlying `POST /v1/c/<slug>/ai/chat`
endpoint and its SSE wire format.
