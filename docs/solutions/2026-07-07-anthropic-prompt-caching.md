---
title: Anthropic prompt caching in the AI proxy
type: architecture
area: primitives
date: 2026-07-07
---

The `/v1/c/:slug/ai/chat` runtime proxy applies Anthropic prompt caching automatically. Canvas authors do not opt in from the SDK; the server marks cache breakpoints before forwarding a chat to the provider and returns the cache usage counters in the existing SSE `done` frame.

Keep the Anthropic-specific API shape inside `apps/server/src/ai/provider.ts`. With the AI SDK Messages API, the stable system prompt is sent as a leading `role: "system"` message with `providerOptions.anthropic.cacheControl = { type: "ephemeral" }`, so the provider call must use `allowSystemInMessages: true` instead of the top-level `system` field. The second breakpoint belongs on the last non-empty message before the newest user turn. Do not mark the newest user message or any assistant message after it, because that would cache unstable work instead of the reusable conversation prefix.

Normalize usage at the provider seam. AI SDK 6 exposes the total input as `usage.inputTokens`, cache writes as `usage.inputTokenDetails.cacheWriteTokens`, and cache reads as `usage.inputTokenDetails.cacheReadTokens`. The route, SDK, and repository use Anthropic's public names, `cacheCreationInputTokens` and `cacheReadInputTokens`, and default both to zero so old providers and old tests remain compatible.

Price from persisted usage, not from provider-specific assumptions at the route. `costUsd` treats `inputTokens` as total input tokens, subtracts cache write/read tokens for the uncached input portion, prices cache writes at `1.25x` input, and prices cache reads at `0.1x` input. `ai_usage.cost_usd` remains the quota and spend source of truth; cache counters are explanatory fields for verification and reporting.

The `ai_usage` schema has real dual-dialect migrations for the two new cache columns, both `NOT NULL DEFAULT 0`. Avoid schema-only edits here: production runs migrations at boot, and tests build fresh databases through the migration folders.

Returning cache-read counts can reveal that a caller recently sent an identical stable prompt prefix through the same Anthropic workspace. That is acceptable under the current authenticated-org runtime model, but the proxy must not store prompt text or add user-, canvas-, or organization-identifying material to provider-visible cache blocks.

See also:

- [AI proxy + Realtime primitives](2026-06-13-ai-realtime-primitives.md)
- [Canvas primitives runtime API](2026-06-13-canvas-primitives-runtime-api.md)
- [Dual-dialect Drizzle seam + pglite testing](2026-06-13-dual-dialect-drizzle-seam.md)
