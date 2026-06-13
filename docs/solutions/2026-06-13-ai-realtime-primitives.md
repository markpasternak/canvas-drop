---
title: AI proxy + Realtime primitives (M9) — the provider seam, SSE envelope, and the WebSocket handshake-auth split
type: architecture
area: primitives
date: 2026-06-13
---

## What this is

The M9 build (plan 009): the **AI** primitive (Anthropic-first LLM proxy, SSE
streaming, allowlist, USD quotas, metering) and the **Realtime** primitive
(ephemeral per-canvas pub/sub + presence over WebSocket). Both hang off the
existing `/v1/c/:slug/*` runtime seam ([[canvas-primitives-runtime-api]]) behind
`requireCapability` ([[canvas-capability-model]]). Read this before touching AI,
realtime, the WS wiring, or quotas.

## AI: the provider seam is one file (Vercel AI SDK, quarantined)

`apps/server/src/ai/provider.ts` is the **only** module that imports `ai` /
`@ai-sdk/anthropic`. Everything else (the route, all tests) depends on a narrow
`ModelProvider` interface (`streamChat(input) → { textStream, usage }`). This
keeps the test suite offline and decoupled from the AI SDK's version-volatile mock
surface, and contains v5/v6 drift to one file. A second provider later is
`createOpenAI(...)` behind the same seam — no canvas-code change (BUILD_BRIEF §6.6.3).

- **The provider key is server-side only** (`config.ai.apiKey`) and never appears
  in any response or the SDK bundle (§12.0 no-secrets-in-browser).
- **`ai` pulls `@opentelemetry/api`**, which is an *optional peer* of `drizzle-orm`
  → installing it created a **second drizzle-orm instance** (otel vs non-otel peer
  variant), and the two `SQL` types are nominally incompatible, breaking the
  dual-dialect column unions in `tsc`. Fix: add `@opentelemetry/api` to both
  `packages/shared` and `apps/server` so drizzle resolves a single variant. Watch
  for this whenever a new dep drags in an optional drizzle peer.

## AI: pricing, quotas, and the abandoned-stream quota leak

- **Pricing is code, not config** (`ai/pricing.ts`, USD per 1M tokens). The admin
  allowlist (`CANVAS_DROP_AI_MODELS`) bounds *which* models run; the table turns
  tokens into the cost the quotas sum. Unknown-but-allowlisted model → cost 0 +
  warn (never crash). Default allowlist is real IDs (`claude-haiku-4-5`,
  `claude-sonnet-4-6`, `claude-opus-4-8`), not the old placeholders.
- **Quota windows** are pure UTC functions (`ai/quota.ts`): per-user *daily*,
  per-canvas *monthly*. Best-effort check-then-write — overshoot scales with
  in-flight concurrency (bounded by the per-call `maxTokens` cap), accepted on the
  trusted-org model.
- **Record usage in a `finally`** (success, upstream error, *and* client abort),
  and wire `c.req.raw.signal` into the provider. Otherwise an abandoned stream
  records nothing and the per-user quota is silently under-counted under
  abandon-and-retry — the inverse of the TOCTOU overshoot, and repeatable. (Caught
  by the plan's adversarial review before build.)
- **`ai_usage` is the single source of truth** for AI tokens/cost/op-count — there
  is **no** parallel `usage_events` `ai_op` row (it would be a dead write). The
  usage tab reads `ai_usage.canvasTotals`.
- **SSE envelope:** `data: {"type":"delta",text}` … then `{"type":"done",usage,cost}`
  or `{"type":"error",code,message}`. Pre-stream failures (bad body / model /
  quota / capability) are normal JSON `{code}` HTTP errors so the SDK maps
  status→typed error before reading the stream.

## Realtime: the handshake-auth-vs-capability split (the load-bearing decision)

The WS route is registered **inside `canvasApiRoutes`**, so the upgrade GET flows
through the same `app.use("*")` middleware as the HTTP primitives:
gateway → resolve+authorize (`decideCanvasAccess`) → password gate →
`canvasApiIsolation`. **`@hono/node-ws`'s `injectWebSocket` dispatches the upgrade
through `app.fetch`** (with `env.incoming = the raw upgrade request`), so:

- The **full middleware chain runs** — login, authorization, password gate, and
  Origin scoping all apply at the handshake. An auth/authorization failure
  short-circuits before the `upgradeWebSocket` handler runs → **no `101`** (the
  socket is refused with the deny status). A WebSocket can never be a back door.
- **Cookies pass through** (session auth works) and **`getConnInfo` resolves the
  socket peer** on the upgrade (proxy-mode trusted-IP auth works). Both verified.

**Capability is the one check that is post-101** (accept-then-close): the upgrade
is accepted, then `onOpen` closes **4403** with a `CAPABILITY_DISABLED` frame if
realtime is off. The SDK maps 4403 → `CapabilityDisabledError` (§6.7.11 graceful
degradation). Capability-off is a feature flag, not a security boundary — so
accept-then-close is correct, while auth failures stay refuse-the-upgrade.
**Never move a §12.0 invariant check into `onOpen`.**

- The `@hono/node-ws` peer range names node-server v1, but the repo runs v2 — the
  mismatch is cosmetic: node-ws only uses `server.on("upgrade")` and `app.fetch`,
  both stable. It installs and works.
- **WS URL targets the base host** (same `apiBase` as the HTTP primitives, protocol
  → `ws`/`wss`), **not** the canvas subdomain — `/v1/c/:slug/*` is mounted on the
  base host; connecting to the subdomain would hit the `"canvas"`-role content
  chain, not `canvasApiRoutes`. The browser still sends `Origin = the page origin`,
  which `canvasApiIsolation` validates. (Caught by the plan's adversarial review.)

## Realtime: the hub + revoke-drops-socket

`realtime/hub.ts` is single-process, in-memory (durable state stays in KV, §6.7.6;
horizontal scaling needs a broker later, §18). The **whole wire protocol lives in
`handleMessage`** so it is unit-testable with fake sockets — no real WebSocket.
Cross-canvas isolation is structural: a connection's `canvasId` is fixed at
handshake and every op is scoped to it; the client channel name is only a key
*within* its canvas. Sender identity on publish/presence is the server-resolved
user, never the client frame (§12.0 #2).

**Revoke-drops-socket (§12.0 #5)** has two layers, and the hooks must wrap the
*actual* mutation handlers — there is no `setShared`; sharing/expiry change via
`PATCH /:id/settings`, capabilities via `PATCH /:id/capabilities`:

- **Instant:** settings (un-share/expiry → `revalidateCanvas`; password-set →
  `dropGatedNonOwners`), capabilities (→ `revalidateCanvas`, so turning realtime
  off drops live sockets — the heartbeat alone would *not*, since it only re-runs
  `decideCanvasAccess`, which doesn't check the capability flag), slug-regen
  (→ `dropCanvas` all), delete/archive (→ `revalidateCanvas`, everyone denied).
- **Heartbeat backstop (~60 s, §9.7 default):** re-runs `decideCanvasAccess` +
  `assertCapability` + an `isUserActive` check, so time-based **expiry** and
  admin **block/delete** (which fire no mutation hook) drop within one tick. The
  residual ≤60 s window for those identity/time-only cases is accepted on the
  trusted-org model.
- Close codes: `4401` authn/authz revoked, `4403` capability disabled, `4429`
  connection/rate limit. The SDK treats 4403/4401 as terminal (no reconnect).

## Testing the WebSocket end-to-end

`canvas-realtime.test.ts` runs a **real `serve()` + `injectWebSocket` + the `ws`
client** in two setups: the **full app** (dev auth) proves the upgrade traverses
the gateway (101 on a valid canvas, *no 101* on a 404 canvas, 4403 on
capability-off), and an **identity-injected** minimal app (an `x-test-user` header
middleware) proves cross-canvas isolation, revoke-drops-socket (4401), and
presence with a *non-admin* viewer that dev mode can't produce. A refused upgrade
surfaces to the `ws` client as `unexpected-response` with the HTTP status.

See also [[canvas-primitives-runtime-api]], [[canvas-capability-model]],
[[auth-invariant-checklist]], [[dual-dialect-drizzle-seam]].
