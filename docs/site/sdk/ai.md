# AI

Call a language model from your canvas without holding a provider key.
`canvasdrop.ai` posts your messages to the server, which runs the model call
with the instance's key and streams the reply back. The key never reaches the
browser; there is nothing to configure in the page. Switch on the AI capability
for the canvas first (see [Capabilities](/docs/authoring/capabilities)); the
operator must also have configured a provider key for the instance.

```js
const { text, usage, cost } = await canvasdrop.ai.chat(
  [{ role: "user", content: "Summarise this poll result in one line." }],
  { model: "claude-haiku-4-5" },
);
// text:  the model's reply (string)
// usage: { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }
// cost:  number (USD)
```

Two entry points, both backed by `POST /v1/c/{slug}/ai/chat`:

- `chat(messages, options)` awaits the full response.
- `stream(messages, options)` yields text as it arrives.

`messages` must hold at least one message. `options.model` is **required** and
must be on the instance's [model allowlist](#models). Calls go to Anthropic;
other providers are not in v1.

## Chat

`chat(messages, options)` collects every text delta and resolves once with
`{ text, usage, cost }` (the snippet above). It rejects if the model is not
allowlisted, a quota or rate limit is hit, or the stream ends early; see
[Errors](#errors).

`cost` is the call's price in USD, computed on the server from its per-model
price table and the token counts the provider reported. It is the same number
the spend quotas sum.

## Stream

Render the reply as it is generated:

```js
const output = document.querySelector("#answer");
for await (const delta of canvasdrop.ai.stream(messages, { model: "claude-haiku-4-5" })) {
  output.textContent += delta;
}
```

`stream()` yields only text; usage and cost are not available from it. Use
`chat()` when you need them.

There is no abort option. Breaking out of the loop stops delivery to your code
but does not stop the upstream call, and every call is metered once, including
one the viewer abandons mid-stream, so it still counts against the quotas.

## Messages and options

```ts
type AiMessage = { role: "user" | "assistant"; content: string };

type AiChatOptions = {
  model: string;       // required; must be allowlisted
  system?: string;     // system prompt (not a message role)
  maxTokens?: number;  // positive integer; default 1024, clamped to 8192
};

type AiUsage = {
  inputTokens: number;                // total prompt tokens, cached or not
  outputTokens: number;
  cacheCreationInputTokens: number;   // prompt-cache writes, else 0
  cacheReadInputTokens: number;       // prompt-cache reads, else 0
};

type AiResult = { text: string; usage: AiUsage; cost: number };
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

`maxTokens` caps the model's output. Omit it for `1024`; a larger value is
clamped to `8192`; a zero, negative, or fractional value rejects with
`INVALID_BODY` (400). There are no options for temperature, tools, or stop
sequences.

The request body (messages plus system prompt, as JSON) must stay under
256 KiB; beyond that the server rejects with `BODY_TOO_LARGE` (413). Trim long
conversations client-side rather than sending the whole history every turn.

## Models

The operator sets the allowlist with `CANVAS_DROP_AI_MODELS` (a CSV; default
`claude-haiku-4-5,claude-sonnet-4-6,claude-opus-4-8`), and an admin can override
it at runtime. Use the exact model id as configured. Asking for a model that is
not on the list, or one that is listed but has no entry in the server's price
table, rejects with `MODEL_NOT_ALLOWED` (403); the second case is deliberate, so
an unpriced model cannot run up spend the quotas cannot see. Ask your
administrator to add the model if you need it.

## Prompt caching and cost

Prompt caching is automatic and best-effort. The server marks two stable prefix
points for Anthropic's ephemeral prompt cache: the system prompt, when present,
and the last non-empty message before the newest `user` turn. Repeating the same
system prompt and conversation history across turns is what makes the cache hit.

`usage.inputTokens` is the total prompt size; `cacheCreationInputTokens` and
`cacheReadInputTokens` say how many of those tokens wrote to or were read from
the cache. Both are `0` when the provider returned no cache metrics, the prompt
was too short to cache, or the prefix did not match. Cache writes are priced at
1.25x the model's input rate and cache reads at 0.1x, so a cached follow-up turn
costs less and adds less to the quota windows.

## Limits

| Limit | Value | Error when exceeded |
| --- | --- | --- |
| AI calls per viewer per minute, across all canvases | 10 (`CANVAS_DROP_RATELIMIT_AI_PER_MIN`) | `RATE_LIMITED` (429, with `Retry-After`) |
| Spend per viewer per UTC day | 5 USD (`CANVAS_DROP_AI_USER_DAILY_USD`) | `QUOTA_EXCEEDED` (429) |
| Spend per canvas per UTC month | 50 USD (`CANVAS_DROP_AI_CANVAS_MONTHLY_USD`) | `QUOTA_EXCEEDED` (429) |
| Output tokens per call | 1024 default, 8192 maximum | clamped, never an error |
| Request body | 256 KiB | `BODY_TOO_LARGE` (413) |

The two spend caps are instance defaults an admin can change at runtime. A call
is refused when spend in the window already meets the cap; a call that starts
under the cap runs to completion even if it crosses it. The HTTP response says
which window closed (`scope: "user_daily"` or `"canvas_monthly"`); the SDK error
carries only the code and status. Windows reset at the UTC day and month
boundaries.

Retained legacy guest sessions have their own gates. AI is off for them unless
the owner opted the canvas in (`GUEST_AI_DISABLED`, 403), and the owner can set
a per-canvas monthly USD ceiling for guest calls; once the canvas's spend this
month reaches it, guest calls are refused with `GUEST_AI_CAP` (429). People
added through **Add person** sign in as members and are not affected.

## Errors

Every method rejects with a `CanvasdropError` subclass; branch on `err.code`, or
catch the subclass you care about.

- `QUOTA_EXCEEDED` and `GUEST_AI_CAP` throw `QuotaExceededError` with the wire
  code in `err.code` and `429` in `err.status`. `BODY_TOO_LARGE` also arrives as
  a `QuotaExceededError`, with `413` in `err.status`.
- `MODEL_NOT_ALLOWED` (403), `GUEST_AI_DISABLED` (403), `INVALID_BODY` (400),
  and `RATE_LIMITED` (429) throw a plain `CanvasdropError` with that `code`.
- AI switched off for the canvas, the canvas backend off, or no provider key on
  the instance throws `CapabilityDisabledError` (`code: "CAPABILITY_DISABLED"`,
  403); `err.hint` names the gate that failed.
- On a Public link canvas, viewers other than the owner and editors get
  `STATIC_ONLY` (403): public canvases are static-only and every primitive is
  refused.
- If the stream ends before its terminal frame, both `chat` and `stream` throw
  `AI_STREAM_TRUNCATED` (502). A provider failure mid-stream throws
  `AI_UPSTREAM_ERROR` (502); an unparseable frame throws `MALFORMED_FRAME`
  (502). Text already yielded by `stream()` before the error stays with you.

```js
try {
  const { text } = await canvasdrop.ai.chat(messages, { model: "claude-haiku-4-5" });
  show(text);
} catch (err) {
  if (err.code === "QUOTA_EXCEEDED") showBanner("AI budget used up for now");
  else if (err.code === "RATE_LIMITED") showBanner("Slow down a little");
  else throw err;
}
```

See [error codes](/docs/api/errors) for the full list, and the
[Runtime API](/docs/api/runtime-api) for the `POST /v1/c/{slug}/ai/chat`
endpoint and its SSE wire format.
