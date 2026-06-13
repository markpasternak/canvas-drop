# Plan 009 — M9: AI proxy + Realtime primitive (areas H + R)

**Status:** completed
**Milestone:** BUILD_BRIEF §16 M9 (areas **H** = AI primitive §6.6/D12, **R** = Realtime primitive §6.7/D22)
**Branch:** `feat/m9-ai-realtime` (single branch, autonomous full-scope round)
**Predecessors (merged):** plan 006 (capability model), plan 007 (M6 primitives runtime seam), plan 008 / PR #18 (editor polish).

Read first: `docs/solutions/2026-06-13-canvas-primitives-runtime-api.md` (the `/v1/c/:slug` seam, `{code}` error envelope, dual-dialect KV pattern, served SDK), `docs/solutions/2026-06-13-canvas-capability-model.md` (`requireCapability`, the effective-state rule), `docs/solutions/2026-06-13-auth-invariant-checklist.md` (§12 invariants + trust-model calibration), `docs/solutions/2026-06-13-dual-dialect-drizzle-seam.md` (schema + migration generation).

---

## 1. Goal & success criteria

Make canvases gain two more backend capabilities, both behind the existing `/v1/c/:slug/*` runtime seam and the `requireCapability` guard:

1. **AI primitive (H):** an Anthropic-first LLM proxy with SSE streaming, an admin model allowlist, per-user daily + per-canvas monthly USD quotas, and per-call metering into a new `ai_usage` table. **The provider API key is server-side only — it never reaches the browser.** Provider access goes through a `getModel(provider, model)` factory (Vercel AI SDK shape, §6.6.3) so a second provider is a later config/code-isolated change, not a rewrite of canvas code.
2. **Realtime primitive (R):** a WebSocket upgrade at `GET /v1/c/:slug/realtime` giving ephemeral per-canvas pub/sub + presence. Messages are **never persisted** (durable state stays in KV). The handshake runs the *identical* authorization path as the HTTP API (login on every request, canvas authorization, password gate, cross-canvas/Origin scoping). Connection + rate + payload limits apply. Revoke/disable/expiry/delete drop live sockets. Honors `CANVAS_DROP_REALTIME` (default on; single-process in-memory fan-out).
3. **SDK additions:** `canvasdrop.ai.*` and `canvasdrop.realtime.channel(name).{publish,subscribe,unsubscribe,presence}`, typed catchable errors, and graceful degradation when a capability or global is off.

**Demo (from §16 M9):** an AI chat demo streams; a poll updates live for two users and revoking the share drops the second instantly.

**Out of scope:** admin panel (M7), gallery (M8), `generateObject` structured-output helper (§6.6.10, v1.1), user-provided keys (§6.6.13, never), KV change-subscriptions / message history (§6.7.12, later), multi-process realtime broker (§18, later — called out as a known limit).

### Hard invariants this plan must uphold (§12.0)

- **#1 login on every request** — including the WebSocket handshake (it flows through `authGateway`).
- **#2 no impersonation** — AI metering attribution and realtime presence/publish sender id come from the *server-resolved* identity, never the client payload.
- **#3 password gate honored** — the AI route and the WS handshake replicate the gate check the content path does (the runtime seam already does this for kv/files/me; realtime + ai inherit it).
- **#4 no cross-canvas reach** — a socket can only join channels of the canvas that served it; cross-canvas Origin is refused; AI quota is per the resolved canvas. Tested both modes.
- **#5 lifecycle honored instantly** — revoke/expiry/disable/delete/slug-regen/password-set drop live sockets on the next request *and* proactively via a hub hook (the "drops the second instantly" demo).
- **No secrets in the browser** — provider key server-side only; never serialized into any response or the SDK bundle.

Calibrate everything else to the trusted-org model (best-effort quota TOCTOU, in-memory rate limiting) — don't build anti-malicious-insider machinery.

---

## 2. Architecture decisions (resolved forks — BUILD_BRIEF defaults taken)

### D-AI-1 — Provider abstraction: Vercel AI SDK behind a one-file seam
§6.6.3 names the Vercel AI SDK as the provider shape (chosen for provider-swappability — the repo's "everything behind an interface" rule). We honor it but **quarantine the dependency** in `apps/server/src/ai/provider.ts`. Everything else depends on a narrow local interface:

```ts
interface ModelProvider {
  // model already validated against the allowlist by the caller
  streamChat(input: { model: string; system?: string; messages: ChatMessage[]; maxTokens: number; signal?: AbortSignal })
    : { textStream: AsyncIterable<string>; usage: Promise<{ inputTokens: number; outputTokens: number }> };
}
```

Default impl uses `@ai-sdk/anthropic` `createAnthropic({ apiKey, baseURL })` + `ai`'s `streamText` (with `maxRetries`, D-AI-5). The AI route and all tests depend on `ModelProvider`, never on `ai` directly — tests inject a fake provider that yields canned deltas + usage, so **no network and no `ai`-version coupling in the test suite.** Provider key comes from `config.ai.apiKey` (the only `process.env` reader is config, §8.1).

*Decision note (review — scope F1/adversarial F8 challenged this seam):* the `ModelProvider` interface is one method and one production impl. We keep it deliberately — the concrete payoff is that the entire test suite (U4 especially) is decoupled from the AI SDK's own (version-volatile) mock surface and runs offline; reversal cost is one file. It is not speculative generality, it is a test seam. The "(Vercel AI SDK)" choice itself is binding per §6.6.3 (provider-swappability is the repo's "everything behind an interface" rule); the seam quarantines the dependency to `provider.ts` so v5 surface drift can't ripple.

### D-AI-2 — Model IDs + pricing (from the claude-api skill, cached 2026-06-04)
Allowlist is operator config (`CANVAS_DROP_AI_MODELS`); default updated from placeholder strings to real IDs: `["claude-haiku-4-5","claude-sonnet-4-6","claude-opus-4-8"]`. Cost is computed from a code-owned pricing table (`ai/pricing.ts`, USD per 1M tokens, input/output):

| model | input $/MTok | output $/MTok |
|---|---|---|
| claude-opus-4-8 | 5 | 25 |
| claude-opus-4-7 | 5 | 25 |
| claude-opus-4-6 | 5 | 25 |
| claude-sonnet-4-6 | 3 | 15 |
| claude-haiku-4-5 | 1 | 5 |
| claude-fable-5 | 10 | 50 |

Unknown model → cost 0 + a warn log (tokens still recorded). The allowlist is enforced at the route (out-of-list → `400 {code:"MODEL_NOT_ALLOWED"}`), so unknown-priced models only occur if an operator allowlists something we don't price — degrade gracefully, don't crash.

### D-AI-3 — SSE framing
`Content-Type: text/event-stream`, one JSON object per `data:` line, `\n\n`-terminated. Event protocol (mirrors the runtime `{code}` envelope style):
- `data: {"type":"delta","text":"..."}` — incremental text.
- `data: {"type":"done","usage":{"inputTokens":N,"outputTokens":N},"cost":0.0123}` — terminal success.
- `data: {"type":"error","code":"...","message":"..."}` — terminal error (provider/upstream failure; no provider internals leaked).
Pre-stream failures (bad body, model not allowed, quota exceeded, capability off) return a normal JSON `{code}` HTTP error (400/403/429) — the stream only opens once the request is accepted, so the SDK can map status→typed error before reading the body.

**Abandoned-stream / abort handling (review fix — adversarial F5).** The route wires the HTTP request's `AbortSignal` (Hono `c.req.raw.signal`) into `provider.streamChat({ signal })` so a client disconnect stops pulling tokens from the upstream (no runaway cost). Usage metering and `ai_usage` recording happen in a **`finally`** that runs on success, provider error, *and* client abort — so consumed tokens are always recorded against the quota even when the client vanishes mid-stream (otherwise the per-user quota is silently under-counted under abandon-and-retry, defeating its purpose). On abort we record whatever partial `usage` the provider exposes (best-effort; 0 if none).

### D-AI-5 — Upstream retry/backoff (§6.6.9 [v1])
§6.6.9 requires retry/backoff for upstream 429/5xx, "handled uniformly by the SDK layer." The AI SDK's `streamText` accepts `maxRetries` (exponential backoff); set it in `ai/provider.ts` (default 2). Retries happen *before the first byte streams* (the AI SDK retries the initial request, not mid-stream), so they don't corrupt an open SSE response; a final failure after retries surfaces as the `error` frame (or a pre-stream HTTP error if it fails before the stream opens).

### D-AI-4 — Quota windows
Per-user **daily** = current UTC calendar day start; per-canvas **monthly** = current UTC calendar month start (`ai/quota.ts`, pure functions of `now`). Pre-call check sums `ai_usage.cost_usd` in each window and rejects with `429 {code:"QUOTA_EXCEEDED", scope:"user_daily"|"canvas_monthly"}` if the *prior* spend already meets/exceeds the limit. Best-effort TOCTOU (corrected bound — adversarial F6): overshoot scales with **in-flight concurrency** — N requests that each pass the pre-check before any record lands overshoot by up to N × the per-call cost cap (`maxTokens` is capped server-side, so the per-call cost ceiling is bounded). Accepted on the trusted-org model (check-then-write, not atomic; documented so an operator sizes limits knowing overshoot scales with concurrency, not by one call). Limits from `config.ai.userDailyUsd` / `config.ai.canvasMonthlyUsd` (defaults $5/day, $50/month — §12.3).

### D-RT-1 — WebSocket transport: `@hono/node-ws`
`createNodeWebSocket({ app })` yields `upgradeWebSocket` (route helper) + `injectWebSocket(server)`. Chicken-and-egg (the helper needs the app, routes need the helper) is resolved by passing a `registerWebSocket?(app) => UpgradeWebSocket` callback into `buildApp`; `buildApp` calls it right after `new Hono()`, threads `upgradeWebSocket` into `canvasApiRoutes`, and `index.ts` captures `injectWebSocket` via closure to call after `serve()`. Unit tests that don't need WS omit the callback (the realtime route then isn't registered); WS integration tests start a real `serve()` + `injectWebSocket` and connect with the `ws` client.

### D-RT-2 — Handshake auth vs capability degradation (the key security split)
The realtime route is registered **inside `canvasApiRoutes`** (mounted at top-level `app.route("/v1/c/:slug", …)` in `app.ts`, *after* `app.use("*", authGateway)`). Its own per-request pipeline — resolve+authorize the canvas (`decideCanvasAccess`), password gate (`verifyGrant`/`GATE_COOKIE`), then `canvasApiIsolation` (Origin/slug + cross-canvas) — runs as the `canvasApiRoutes` `app.use("*", …)` middleware **before** the `upgradeWebSocket` route handler. **Important (feasibility F1):** these are the gate checks that live *inside `canvasApiRoutes`* (`canvas-api.ts`), **not** the `"canvas"`-role `onlyCanvas(...)` content chain in `app.ts` (which only fires for the canvas-content role). Wire the realtime route into `canvasApiRoutes`; do not reuse the content-chain `canvasAccess`/`passwordGate` middlewares.

**Pre-101 vs post-101 (security F2 — do not blur these):**
- **Pre-101 (refuse the upgrade, no `101`):** login (`authGateway`), canvas access/deny (`decideCanvasAccess`), password gate, Origin/cross-canvas isolation. Any failure → HTTP 401/403/404 and **no socket**. A WebSocket can never be a back door (§12.5 / line 610). Browsers send `Cookie` and `Origin` on the handshake, so session auth and Origin scoping apply here for free. **Never move a §12.0 invariant check into `onOpen`.**
- **Post-101 (accept-then-close — capability flag only):** `onOpen` checks `assertCapability(canvas,"realtime",config)` (folds in the per-canvas `backend_enabled` master switch, the per-canvas `cap_realtime` flag, **and** the `CANVAS_DROP_REALTIME` global — all three via `isCapabilityEnabled`). If off it sends one `{"type":"error","code":"CAPABILITY_DISABLED"}` frame and closes **4403**. The SDK maps 4403 → `CapabilityDisabledError` (§6.7.11 graceful degradation). Capability-off is a feature flag, not a security boundary, so accept-then-close is correct.

**Verify during U6 (feasibility F2 / adversarial F2):** that the upgrade GET genuinely traverses `authGateway` and the `canvasApiRoutes` middlewares under `@hono/node-ws` `injectWebSocket` (it dispatches the upgrade through `app.fetch`), and that `getConnInfo(c).remote.address` still resolves the socket peer on the upgrade path (proxy-mode trusted-IP auth depends on `c.get("clientIp")`). `canvasApiIsolation` sets CORS headers *after* `next()`; on an upgrade the response is the node-ws 101 — confirm that the post-`next()` `applyCors` is a harmless no-op on the hijacked response (its *rejection* checks all run before `next()`, so security is unaffected; this is a correctness/no-crash check). Tests must assert both: unauthenticated → no 101, **and** authenticated (incl. a proxy-mode header path) → 101.

**Close-code table (coherence F3 — defined once):** `4401` = authn/authz revoked or no longer authorized (heartbeat/revalidate drop of a denied socket); `4403` = capability disabled; `4429` = connection or rate limit exceeded. The SDK treats `4403` as terminal (`CapabilityDisabledError`, no reconnect) and `4401` as terminal-for-now; other closes trigger reconnect with backoff.

### D-RT-3 — Hub: single-process in-memory, injectable Socket
`realtime/hub.ts` holds `Map<canvasId, Map<channel, Set<Conn>>>`. A `Conn` wraps a minimal `Socket` interface (`send(string)`, `close(code, reason)`) so the hub is unit-tested without real sockets. Cross-canvas isolation is structural: a `Conn`'s `canvasId` is fixed at handshake from the server-resolved canvas, and `publish`/`presence`/`subscribe` are always scoped to that `canvasId` — a client channel name is only a key *within* its canvas. One shared `RealtimeHub` singleton is constructed in `index.ts` and injected into both `canvasApiRoutes` (the socket side) and `managementRoutes` (the revoke side).

**Hub construction + method set (coherence F1/F2/F5 — settle the ambiguous signatures).** The hub is constructed with its access deps so the revoke methods take only a `canvasId` (no per-call `decide`/`freshCanvas` threading): `createHub({ canvases, config })`. Methods:
- `add(conn)`, `remove(conn)`, `subscribe(conn, channel)`, `unsubscribe(conn, channel)`, `publish(conn, channel, event, data)`, `presence(canvasId, channel)`, `connectionCount(canvasId)`.
- `revalidateCanvas(canvasId)` — fetches the fresh canvas, and for each live socket re-runs `decideCanvasAccess(canvas, {id,isAdmin}, now)` **and** `assertCapability(canvas,"realtime",config)` **and** the user-state check (blocked / still exists); any failure → `close(4401|4403)`. Covers share-off, expiry, disable, delete, slug-regen, capability-off, and block/delete in one path.
- `dropGatedNonOwners(canvasId)` — for a just-password-set canvas, close non-owner/non-admin sockets (they hold no re-verified gate grant; they must re-handshake through the gate). Close `4401`.

There is **no** `dropCanvas`/`decide`-param method — earlier drafts referenced one; it's folded into `revalidateCanvas`.

**Frame-before-register ordering (adversarial F4).** `onMessage` may in principle fire before `onOpen` finishes registering the `Conn`. The hub treats any frame whose `Conn` is not registered (or is closing) as a no-op, so no `publish`/`subscribe` can act before the `onOpen` capability + conn-limit checks complete.

### D-RT-4 — Wire protocol (client ↔ server JSON frames)
Client→server: `{type:"subscribe",channel}`, `{type:"unsubscribe",channel}`, `{type:"publish",channel,event,data}`, `{type:"presence",channel}`.
Server→client: `{type:"subscribed",channel}`, `{type:"message",channel,event,data,from}`, `{type:"presence",channel,users:[{id,name}]}`, `{type:"join",channel,user}`, `{type:"leave",channel,user}`, `{type:"error",code,message}`.
**`from` / `user` always come from the connection's server-resolved identity**, never the client frame (§12.0 #2/#10). Presence is deduped per user id (multiple tabs = one presence entry, with a refcount).

### D-RT-5 — Limits (§12.3)
30 concurrent connections/canvas (over → close 4429 in `onOpen`), 100 messages/min/user (sliding/token-bucket in the hub; over → drop the frame + `error` frame, repeated abuse closes 4429), 16 KB/message (over → drop + `error` frame). "Drop on breach" per §6.7.9.

### D-RT-6 — Revoke-drops-socket (instant + heartbeat backstop)
Hooks must wrap the **actual** management mutation handlers (adversarial F3 / security F7 — there is no `setShared` handler; sharing/expiry change through `PATCH /:id/settings` → `updateSettings`, and capabilities through `PATCH /:id/capabilities`):
- **`PATCH /:id/settings`** (changes `shared`, `sharedExpiresAt`, password, etc.) → after the write, call `hub.revalidateCanvas(canvasId)`; if the patch **set/changed a password**, also call `hub.dropGatedNonOwners(canvasId)`. This catches share-off and a newly-set (incl. already-past) `sharedExpiresAt`.
- **`PATCH /:id/capabilities`** (per-canvas `cap_realtime` / `backend_enabled` off) → `hub.revalidateCanvas(canvasId)`. Because `revalidateCanvas` now re-checks `assertCapability`, turning realtime off for a canvas **drops its live sockets** (the gap adversarial F3 flagged: the old design never dropped on capability-off).
- **disable / delete / regenerate-slug** handlers → `hub.revalidateCanvas(canvasId)`.
This delivers the "revoking the share drops the second instantly" demo within the same process.
- **Backstop heartbeat:** a server interval (**default 60 s**, matching §9.7; configurable) groups live connections by canvasId, fetches each canvas once, runs the same `revalidateCanvas` logic (`decideCanvasAccess` + `assertCapability` + user blocked/exists), closes the denied, and pings the rest. Covers time-based **expiry** with no mutation, and **admin-block / user-delete** mid-session (which fire no canvas hook). Honors line 610 ("re-checked on every realtime heartbeat").
- **Residual window (documented, accepted on the trusted-org model):** block/delete/expiry that fire no instant hook are dropped within ≤ one heartbeat (≤60 s), not instantly. The §12.0 #5 "instant" guarantee is met for the share/disable/delete/capability/password mutations (instant hook); the time/identity-only cases are heartbeat-bounded.
- **Key regen** is the deploy/programmatic key (capability-model KTD-5) and does **not** authenticate runtime sockets (those use the session identity) — no realtime effect; documented, not wired.

### D-RT-7 — SDK realtime URL (corrected — adversarial F1: must target the base host)
The WebSocket connects to the **same `apiBase` as the HTTP primitives** (i.e. the base host in subdomain mode, first label stripped), with the protocol swapped to `ws`/`wss` (preserve port). This is the *critical* correction: `/v1/c/:slug/*` (and thus `/realtime`) is mounted on the base host inside `canvasApiRoutes`; connecting to the canvas *subdomain* (`{slug}.base/...`) would instead route into the `"canvas"`-role content chain and never reach `canvasApiRoutes` — breaking the handshake-auth story and the demo in subdomain mode.
- Subdomain mode: page is `https://{slug}.base`; WS → `wss://{base}/v1/c/{slug}/realtime` (base host, label stripped). The browser sends `Origin: https://{slug}.base` (the page origin) on the cross-origin WS handshake; `canvasApiIsolation` (subdomain branch) validates `origin === expectedCanvasOrigin(slug)` = `https://{slug}.base` ✓. Cross-origin WS is normal and carries Origin.
- Path mode: page and API share the origin; WS → `ws(s)://{host}/v1/c/{slug}/realtime`. `canvasApiIsolation` falls back to `Sec-Fetch-Site`/`Referer` here — note these are weak/absent on WS upgrades, so path mode keeps the **same reduced cross-canvas isolation already documented for path mode** (§12.2; security F6). Path mode is the local/trusted-self-host case, so this is acceptable and explicitly inherited, not a new gap.
Reuse the existing `detectContext` `apiBase` (don't add a separate `location.host` derivation). One WebSocket per canvas is shared across channels, auto-reconnect + capped backoff; `4403`/`4401` closes are terminal (no reconnect).

---

## 3. Data model

New table `ai_usage` (both dialects, built from shared column helpers — add a `real` helper):

| column | type (pg / sqlite) | notes |
|---|---|---|
| id | text PK | uuidv7 |
| canvas_id | text NOT NULL → canvases.id | |
| user_id | text NOT NULL → users.id | attribution = resolved identity |
| provider | text NOT NULL | e.g. "anthropic" — **in-spec**: §6.6.6 meters "(canvas, user, provider, model, tokens, cost)" |
| model | text NOT NULL | |
| input_tokens | int NOT NULL | |
| output_tokens | int NOT NULL | |
| cost_usd | **real** NOT NULL | USD; summed for quota windows |
| created_at | epochMs NOT NULL | window filtering |

Indexes: `ai_usage_canvas_created_idx (canvas_id, created_at)` (canvas-monthly window + owner usage tab) and `ai_usage_user_created_idx (user_id, created_at)` (user-daily window).

`columns.ts` gains `real`: pg `doublePrecision(name)`, sqlite `real(name)` (from `drizzle-orm/sqlite-core`). Cost is inherently fractional and shown in dollars on the dashboard — a real column reads cleaner than micro-dollar integers, and the parity test covers the new column type generically. Float sums of a few hundred small values are exact enough for quota comparison at this scale (greenfield, trusted-org).

No realtime persistence (§6.7.6). The only realtime DB footprint is a `rt_connect` `usage_events` row per socket open (the type already exists in `UsageType`) for the stats tab. **No `ai_op` `UsageType` is added** (scope F3): each `ai_usage` row *is* the per-call AI op record, so a parallel `usage_events` write would be a redundant dead write — `ai_usage` is the single source of truth for AI tokens/cost/op-count.

**Migration:** edit both schema files, then generate **both** dialects (drizzle-kit) → `drizzle/{sqlite,pg}/0007_<name>.sql` + meta. The schema-parity test passes on schema edits alone, so the full dual-dialect suite is the signal that the migration is real (per the dual-dialect doc).

---

## 4. Units (dependency-ordered; one local commit per unit, gates green per unit)

Gate per unit: `cd …/canvas-drop-m9 && pnpm typecheck && pnpm lint && pnpm test` (both dialects). Tests are mandatory for every feature-bearing unit.

### U1 — `ai_usage` schema, migrations, `real` helper, config model defaults
- `packages/shared/src/db/columns.ts`: add `real` to both dialect sets.
- `schema.pg.ts` + `schema.sqlite.ts`: `aiUsage` table (above) in lockstep.
- `types.ts`: `AiUsage` / `NewAiUsage`. `schema.test.ts`: add `aiUsage` to both parity maps.
- Generate `0007_ai_usage` for both dialects; commit the `.sql` + meta snapshots/journals.
- `config/env.ts`: change `CANVAS_DROP_AI_MODELS` default to the real-ID set (D-AI-2). Also fix the **empty-key-enables-AI** bug (security F8): `capabilityGlobals` currently sets `aiEnabled: config.ai.apiKey !== undefined`, so `CANVAS_DROP_AI_API_KEY=` (empty string) wrongly enables AI and every call 401s. Fix in `capability-guard.ts` → `aiEnabled: !!config.ai.apiKey` (and/or coerce empty string to `undefined` in the config transform). Add a config/guard test for the empty-string case.
- Naming the two `ai_usage` indexes **identically in both dialect files** (feasibility F6) — the parity test asserts index shape across dialects.
- Tests: parity test (auto-covers the table + indexes); `db/repositories/ai-usage.test.ts` stub asserting insert + read on both dialects (fleshed out in U2).

### U2 — `ai_usage` repository + pricing + quota windows
- `db/repositories/ai-usage.ts`: `record(input)`, `userSpendSince(userId, sinceMs)`, `canvasSpendSince(canvasId, sinceMs)`, `pruneBefore(cutoff)` (wire into `pnpm purge` sweep like usage-events). Dual-dialect `any` seam per the pattern; `SUM(cost_usd)` returns 0 when no rows.
- `ai/pricing.ts`: `PRICING` table + `costUsd(model, inTok, outTok)`; unknown model → 0 + warn.
- `ai/quota.ts`: `dayStartUtc(now)`, `monthStartUtc(now)`, `checkQuota({userSpend, canvasSpend, config})` → `{ok:true}` | `{ok:false, scope}`.
- Tests: pricing math incl. fractional + unknown-model; window boundary math (last-ms-of-day vs first-ms-of-next); quota pass/exceed for both scopes; repo window sums on both dialects; **a quota-boundary test seeded to exactly the limit, run on both dialects** (adversarial F7 — `real`/`double precision` SUM can land just under/over the limit; assert consistent behavior across legs).

### U3 — AI provider factory
- `ai/provider.ts`: `ModelProvider` interface (D-AI-1) + `anthropicProvider(config)` default using `@ai-sdk/anthropic` + `ai` `streamText` with `maxRetries` (D-AI-5, default 2 — satisfies §6.6.9 429/5xx retry/backoff) and the passed `AbortSignal`. Verify exact v5 surface against installed types during build (`result.textStream` async-iterable of strings, `result.usage` promise → map to `{inputTokens,outputTokens}`). `ChatMessage` type = `{role:"user"|"assistant", content:string}` (system passed separately).
- Add deps `ai`, `@ai-sdk/anthropic` to `apps/server/package.json`.
- Tests: a `fakeProvider` helper (canned deltas + usage) used here and by U4; a guarded unit asserting `anthropicProvider` constructs without a key throwing only on use (no network).

### U4 — `POST /v1/c/:slug/ai/chat` SSE route
- `routes/canvas-ai.ts` mounted `app.route("/ai", canvasAiRoutes(deps))` in `canvas-api.ts`, behind `requireCapability("ai", config)` (→ `CAPABILITY_DISABLED` 403 when backend off, per-canvas `cap_ai` off, or no provider key configured — the global `aiEnabled` already ANDs `config.ai.apiKey` present).
- Body: `{model, messages, system?, maxTokens?}` (zod-validate; default `maxTokens` modest e.g. 1024, cap to a server max). Model not in `config.ai.models` → `400 {code:"MODEL_NOT_ALLOWED"}`.
- Pre-call quota check (U2) → `429 {code:"QUOTA_EXCEEDED",scope}`.
- Open SSE; wire `c.req.raw.signal` into `provider.streamChat({signal})`; stream `delta` events from `.textStream`. In a **`finally`** (runs on success, provider error, *and* client abort): read whatever `usage` is available, compute cost, and **record `ai_usage`** so the quota always reflects consumed tokens (adversarial F5 — no under-count on abandon). On clean completion, await the record then emit `done`; on provider/upstream throw mid-stream → emit `error` frame (mapped, no internals) then close; on abort → just record + stop (no frame, client is gone).
- Inject `ModelProvider` via deps (default = `anthropicProvider(config)`), so tests pass the fake.
- Tests: streaming happy path + `done` usage/cost; model-not-allowed 400; quota-exceeded 429 (seed `ai_usage`); capability-off 403 (backend off, `cap_ai` off, **empty/no key**); provider-throws → `error` frame; **client-abort mid-stream still records `ai_usage`** (quota-leak regression); metering row written with **server** userId/canvasId (not client-supplied); password-gated canvas rejected without a gate cookie (replicates §12.0 #3); cross-canvas Origin rejected in subdomain mode (inherited from the seam — one assertion).

### U5 — Realtime hub
- `realtime/hub.ts`: `createHub({canvases, config})` (D-RT-3 — deps injected so revoke methods take only `canvasId`). Methods: `add`, `remove`, `subscribe`, `unsubscribe`, `publish`, `presence(canvasId,channel)`, `connectionCount(canvasId)`, `revalidateCanvas(canvasId)` (re-runs `decideCanvasAccess` + `assertCapability("realtime")` + user blocked/exists; denied → `close(4401|4403)`), `dropGatedNonOwners(canvasId)` (close 4401). Per-user rate bucket + per-message size guard. Presence deduped per user with refcount; join/leave emitted to channel subscribers. Frame-for-unregistered-conn = no-op (adversarial F4).
- Tests (pure, fake sockets): fan-out within a canvas; **cross-canvas isolation** (publish in canvas A never reaches canvas B even with the same channel name); presence dedupe across two conns of one user + join/leave; 31st connection rejected; >100 msgs/min dropped; >16 KB dropped; `revalidateCanvas` drops now-denied non-owner / **realtime-capability-off** / blocked user, keeps owner; `dropGatedNonOwners` drops non-owners.

### U6 — Realtime WS route + wiring + revoke hooks
- `routes/canvas-realtime.ts`: `canvasRealtimeRoutes({config, hub, upgradeWebSocket})`. `app.get("/realtime", upgradeWebSocket(c => ({...})))`. `onOpen`: capability check → close 4403 if off; conn-limit → close 4429; else register `Conn{canvasId, user, socket}`, meter `rt_connect`, send presence. `onMessage`: parse + route per D-RT-4 with limits. `onClose`: `hub.remove`. Mount `app.route("/realtime", …)` in `canvas-api.ts` only when `upgradeWebSocket` provided.
- `app.ts`: `buildApp` accepts `registerWebSocket?` + `hub`; call the callback post-`new Hono()`, thread `upgradeWebSocket` + `hub` into `canvasApiRoutes`, pass `hub` into `managementRoutes`.
- `index.ts`: construct `RealtimeHub`, `createNodeWebSocket({app})` via the callback, `injectWebSocket(server)` after `serve()`; start the heartbeat interval; clear it + close sockets on shutdown.
- `management.ts` revoke hooks (D-RT-6 — wrap the **real** handlers): `PATCH /:id/settings` → `hub.revalidateCanvas(canvasId)` (+ `dropGatedNonOwners` when a password was set); `PATCH /:id/capabilities` → `hub.revalidateCanvas(canvasId)`; disable / delete / regenerate-slug → `hub.revalidateCanvas(canvasId)`. Add hooks after each DB write.
- Deps: `@hono/node-ws`; `ws` + `@types/ws` (dev, for the test client).
- Tests (real `serve()` + `injectWebSocket` + `ws` client): handshake refused when unauthenticated / not authorized / wrong canvas Origin (no `101`); **authenticated handshake (incl. a proxy-mode header path) gets `101` and resolves the same identity + `clientIp` as the HTTP path** (feasibility F2 / adversarial F2 — guards the silently-broken-proxy-mode case); **cross-canvas socket isolation** (socket for canvas A cannot receive canvas B publishes); **revoke-drops-socket** (open as non-owner on a shared canvas, owner flips `shared=false` via `PATCH /settings`, socket closes 4401); **capability-off-drops-socket** (owner turns `cap_realtime` off via `PATCH /capabilities`, live socket closes); capability-off-at-handshake → 4403 close → SDK-mappable; conn-limit 4429; message size/rate drop; presence join/leave across two clients.

### U7 — SDK `ai.*` + `realtime.channel()`
- `packages/sdk/src/index.ts`: 
  - `ai.chat(messages, opts) → Promise<{text, usage, cost}>` (accumulates the stream) and `ai.stream(messages, opts) → AsyncIterable<string>` (yields deltas). POSTs `/ai/chat`, parses SSE, maps a pre-stream HTTP error via the existing `errorFromResponse`, maps an in-stream `error` frame to a typed error (`QuotaExceededError`/`CapabilityDisabledError`/`CanvasdropError`).
  - `realtime.channel(name) → { publish(event,data), subscribe(handler), unsubscribe(), presence(): Promise<User[]>, onPresence(handler), onJoin/onLeave, close() }`. `close()` (§11.1, scope F6) unsubscribes this channel's handlers and stops it reconnecting; when the last open channel closes, the shared socket closes. One shared `WebSocket` per client (lazy), auto-reconnect w/ capped backoff, re-subscribe on reconnect; `4403`/`4401` close → terminal `CapabilityDisabledError` / `NotAuthenticatedError` (reject pending `presence()`, surface to handlers, no reconnect). Inject a `WebSocket` impl + `fetch` for tests; browser-entry uses globals.
  - WS URL per D-RT-7 (add to `detectContext` or a `wsBase` helper; preserve port).
- Tests: `ai` parses multi-delta SSE + `done`; maps in-stream `error` frame to `QuotaExceededError`; maps pre-stream 403 to `CapabilityDisabledError`. `realtime` against a fake WebSocket: publish/subscribe round-trip, presence resolve, reconnect re-subscribes, `4403` → `CapabilityDisabledError` (terminal, no reconnect), `close()` then `publish()` does not reconnect. (SDK keeps its own DOM tsconfig; no secrets ever added.)

### U8 — Dashboard usage tab: AI + realtime tiles
- `management.ts` `/:id/usage`: add `aiTokens` (sum input+output from `ai_usage`), `aiCostUsd` (sum), `realtimeConnects` (count of `rt_connect` from `usage_events`). (Peak concurrent connections isn't derivable from ephemeral state — surface connect count and note peak as deferred.)
- `apps/dashboard/src/lib/api.ts` `CanvasUsage` + `usage.tsx`: AI tokens, AI cost ($), realtime connects tiles; drop "AI tokens & cost" / "Peak realtime connections" from `COMING_SOON`.
- Tests: server usage endpoint returns the new fields; dashboard `usage.test.tsx` + `api.test.tsx` render/shape.

### U9 — Learnings, env docs, code review, final gate
- `docs/solutions/2026-06-13-ai-realtime-primitives.md`: the provider seam, the SSE envelope, the WS handshake-auth-vs-capability-degradation split, revoke-drops-socket mechanics, the single-process realtime limit; update `docs/solutions/README.md` index + cross-links.
- `.env.example`: ensure `CANVAS_DROP_AI_*` and `CANVAS_DROP_REALTIME` are documented with the real-ID allowlist default.
- Run `/ce-code-review` on the branch; fix every real finding (weighted hard against §12.0 — provider key never in browser, cross-canvas socket isolation, login at handshake, revoke-drops-socket) with regression tests. Re-run the full dual-dialect gate green.
- Leave the plan **active** (do not mark completed — human coordinates integration).

---

## 5. Shared files touched (integration conflict-watch)
`apps/server/src/app.ts`, `apps/server/src/index.ts`, `packages/shared/src/db/schema.pg.ts`, `schema.sqlite.ts`, `columns.ts`, `types.ts`, `schema.test.ts`, `canvas/capability-guard.ts` (empty-key `aiEnabled` fix), `config/env.ts` (allowlist default), `routes/canvas-api.ts`, `routes/management.ts` (realtime revoke hooks), `packages/sdk/src/index.ts`, `apps/dashboard/src/lib/api.ts` + `routes/canvas.usage.tsx`, `docs/solutions/README.md`, `apps/server/package.json` (+ new migrations under `drizzle/{sqlite,pg}/`).

## 6. Risks & mitigations
- **Vercel AI SDK v5 surface drift** → quarantined in `ai/provider.ts`; verify against installed types; tests never import `ai`.
- **WS upgrade not flowing through middleware** → integration test asserts an unauthenticated handshake gets no `101`; confirms the gateway runs on the upgrade GET.
- **Cross-canvas socket leak** → canvasId fixed server-side at handshake; hub scopes every op by canvasId; explicit isolation test.
- **Float cost drift** → small magnitudes, exact-enough sums at trusted-org scale; revisit only if a real overshoot shows up.
- **Single-process realtime** → explicit known limit (§18); horizontal scaling needs a broker later. Documented, not built.
