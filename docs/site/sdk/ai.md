# AI

Call a language model from a static canvas without holding a provider key. This
page is the reference for `canvasdrop.ai`, the AI primitive on the `canvasdrop`
global that `<script src="/sdk/v1.js">` defines in every canvas. The page posts
your messages to the server, the server runs the call with the instance's key
and streams the reply back, and the key never reaches the browser. By the end
you can await a reply, render it as it streams, read usage and cost, stay inside
the model allowlist and spend caps, and handle every error AI returns.

The canvas needs **Enable backend** on and the **AI** toggle on (it is
pre-enabled) in its **Backend** tab; see
[Capabilities](/docs/authoring/capabilities). The operator must also have
configured a provider key for the instance (`CANVAS_DROP_AI_API_KEY`, or the
key an admin sets in Admin → Settings); without one the capability reads as off.

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  const { text, usage, cost } = await canvasdrop.ai.chat(
    [{ role: "user", content: "Summarise this poll result in one line." }],
    { model: "claude-haiku-4-5" },
  );
  // text:  the model's reply (string)
  // usage: { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }
  // cost:  number (USD)
</script>
```

Two entry points, both backed by `POST /v1/c/{slug}/ai/chat`:

| Method | Returns | Use when |
| --- | --- | --- |
| `chat(messages, options)` | `Promise<{ text, usage, cost }>` | You want the whole reply, plus usage and cost |
| `stream(messages, options)` | `AsyncIterable<string>` of text deltas | You want to render the reply as it is generated |

`messages` must hold at least one message. `options.model` is **required** and
must be on the instance's [model allowlist](#models). Calls go to Anthropic;
there is no per-call provider choice.

## Chat

`chat(messages, options)` collects every text delta and resolves once with
`{ text, usage, cost }`. It rejects if the model is not allowlisted, a quota or
rate limit is hit, the provider fails, or the stream ends early; see
[Errors](#errors).

`cost` is the call's price in USD, computed on the server from its per-model
price table and the token counts the provider reported. It is the same number
the spend quotas sum. If the provider's usage report does not arrive within 5 s
of the stream ending, the call is recorded, and reported, with `0` tokens and
`0` cost.

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

There is no abort option. Breaking out of the `for await` loop stops delivery
to your code but does not cancel the request: the server keeps the call running
to completion. Only a dropped connection (the viewer closes the tab or navigates
away) reaches the server as an abort, which cancels the upstream call. Either
way every call is metered exactly once, including one abandoned mid-stream, so
it still counts against the quotas.

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
`INVALID_BODY` (400). There are no options for temperature, tools, images, JSON
mode, or stop sequences.

The request body (messages plus system prompt, as JSON) must stay under
256 KiB; beyond that the server rejects with `BODY_TOO_LARGE` (413). Trim long
conversations client-side rather than sending the whole history every turn.

## Models

The operator sets the allowlist with `CANVAS_DROP_AI_MODELS` (a CSV; default
`claude-haiku-4-5,claude-sonnet-4-6,claude-opus-4-8`), and an admin can override
it at runtime in Admin → Settings. Use the exact model id as configured. Asking
for a model that is not on the list, or one that is listed but has no entry in
the server's price table, rejects with `MODEL_NOT_ALLOWED` (403). The second
case is deliberate: an unpriced model would cost `0` and the spend quotas could
never see it. The three default models are priced. Ask your administrator to
add a model if you need it.

## Prompt caching and cost

Prompt caching is automatic and best-effort. The server marks two stable prefix
points for Anthropic's ephemeral prompt cache: the system prompt, when it is
non-empty, and the last non-empty message before the newest `user` turn.
Repeating the same system prompt and conversation history across turns is what
makes the cache hit.

`usage.inputTokens` is the total prompt size; `cacheCreationInputTokens` and
`cacheReadInputTokens` say how many of those tokens wrote to or were read from
the cache. Both are `0` when the provider reported no cache activity for the
call. The remainder (`inputTokens` minus both cache counts) is billed at the
model's input rate; cache writes at 1.25x that rate and cache reads at 0.1x, so
a cached follow-up turn costs less and adds less to the quota windows.

## Limits

| Limit | Value | Error when exceeded |
| --- | --- | --- |
| AI calls per viewer per minute, across all canvases | 10 (`CANVAS_DROP_RATELIMIT_AI_PER_MIN`) | `RATE_LIMITED` (429, with `Retry-After`) |
| Spend per viewer per UTC day | 5 USD (`CANVAS_DROP_AI_USER_DAILY_USD`) | `QUOTA_EXCEEDED` (429) |
| Spend per canvas per UTC month | 50 USD (`CANVAS_DROP_AI_CANVAS_MONTHLY_USD`) | `QUOTA_EXCEEDED` (429) |
| Guest AI spend per canvas per UTC month | owner-set; `0` (the default) means no guest-specific cap | `GUEST_AI_CAP` (429) |
| Output tokens per call | 1024 default, 8192 maximum | clamped, never an error |
| Request body | 256 KiB | `BODY_TOO_LARGE` (413) |

The two USD spend caps are instance defaults an admin can change at runtime. A
call is refused when spend in the window already meets the cap; a call that
starts under the cap runs to completion even if it crosses it. The viewer's
daily window is checked first. The HTTP response says which window closed
(`scope: "user_daily"` or `"canvas_monthly"`); the SDK error carries only the
code and status. Windows reset at the UTC day and month boundaries.

Retained legacy guest sessions have their own gates. AI is off for them unless
the owner opted the canvas in (`GUEST_AI_DISABLED`, 403). The owner can also set
a per-canvas monthly USD ceiling for guest calls; once the canvas's total spend
this month reaches it, guest calls are refused with `GUEST_AI_CAP` (429). Both
controls live in the canvas's **Share** tab under **AI for added people** (shown
when a legacy guest is on the people-and-teams list). Only the owner can change them; an editor sees
them read-only. People added through **Add person** sign in as members and are
not affected by either gate.

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
- A provider failure throws `AI_UPSTREAM_ERROR` (502). The server retries a
  transient provider error up to twice before the first byte streams; a failure
  after that arrives mid-stream. If the stream ends before its terminal frame,
  both `chat` and `stream` throw `AI_STREAM_TRUNCATED` (502); an unparseable
  frame throws `MALFORMED_FRAME` (502). Text already yielded by `stream()`
  before the error stays with you.

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
[Runtime API](/docs/api/runtime-api#ai) for the `POST /v1/c/{slug}/ai/chat`
endpoint and its SSE wire format.
