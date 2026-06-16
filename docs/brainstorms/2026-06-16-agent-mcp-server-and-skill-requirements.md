---
date: 2026-06-16
topic: agent-mcp-server-and-skill
---

# Agent MCP server + skill extension — Requirements

## Summary

Add a remote **MCP server** to each canvas-drop instance, mounted at `/mcp`,
authenticated by full OAuth 2.1 that reuses the instance's own login and is built
on the official MCP TypeScript SDK so we write only a thin identity bridge. Extend
the **already-shipped agent skill** to cover MCP as the richer alternative to the
HTTP/curl path, and refresh every agent-facing and marketing surface — `/llms.txt`,
the skill, the docs, and the landing page — so both paths are discoverable.

## Problem Frame

canvas-drop already treats AI agents as first-class authors: the deploy API ships
from day one, `/llms.txt` is a public single-file contract, and a packaged
`skill/canvas-drop/SKILL.md` is downloadable at `/skill.zip`. But every existing
agent path is **per-canvas-key, single-action HTTP**: an agent can `PUT` a ZIP to a
canvas it was handed a key for, and nothing more. There is no identity-scoped,
multi-tool surface an agent can connect to *once* and then create, list, deploy,
and manage canvases across the user's whole account — and no path a non-curl client
(ChatGPT, Claude desktop) can adopt with a single connect-and-consent.

MCP is the cross-vendor standard both Claude and ChatGPT speak, and the deploy API
is already the thin contract a richer client would wrap (the README states "the
future CLI and agent skills are thin clients of exactly this"). The pieces exist;
nothing assembles them into a connect-once, identity-scoped agent surface.

## Key Decisions

- **MCP authentication is full OAuth 2.1, reusing the instance's own login.** The
  slickest, most shareable path: a client adds the `/mcp` URL, gets bounced through
  the org's existing login + a consent screen, and is connected with no secret to
  paste. Chosen over a pasted personal-access-token or wrapping the per-canvas
  deploy key.

- **Use OSS for the protocol and OAuth machinery; write only a thin identity
  bridge.** Build on `@hono/mcp` (v0.3+) — the **Hono-native** MCP kit — composed
  with `@modelcontextprotocol/sdk` (v1.29+, MIT) for the provider model and types.
  `@hono/mcp` ships `StreamableHTTPTransport` and a Hono-native `mcpAuthRouter`
  (returns a `Hono` app) covering authorize / token / Dynamic Client Registration
  (RFC 7591) / revoke / metadata (RFC 9728 / 8414) + PKCE + a `bearerAuth`
  middleware. We do not author the protocol, the OAuth endpoints, or any Express
  bridge — confirmed by spike (see Dependencies / Assumptions).

- **canvas-drop is its own thin authorization server, not a proxy to the upstream
  IdP.** A proxy provider would delegate the OAuth dance (including DCR) to the
  org's IdP — but Google, the prod IdP, does not support Dynamic Client
  Registration, so a pure proxy breaks for the most likely deployment. Instead
  canvas-drop implements a small `OAuthServerProvider` whose `authorize(client,
  params, c)` receives a **Hono `Context`** (the `@hono/mcp` variant), so the login
  gate is literally `sessionSvc.resolveUserId(c)` → `c.redirect('/auth/login?
  returnTo=…')` using the *existing* oidc/proxy/dev login, and tokens are minted
  reusing the existing hashed-token store. Single-process; works regardless of
  upstream IdP.

- **The MCP tool surface is richer than the skill's curl, because OAuth carries
  user identity.** Where the per-canvas-key deploy API is scoped to one canvas, an
  OAuth-authenticated MCP session knows *who* the user is, so it can create and list
  canvases across their account, not just deploy to one.

- **The skill is extended, not rebuilt.** `skill/canvas-drop/SKILL.md` already ships
  the HTTP/curl deploy + browser-SDK guidance. We add an MCP section pointing at the
  connect-once path as the preferred option when the client supports it, and keep
  the curl path for keyed, sessionless agents.

- **One MCP server serves every vendor; no bespoke ChatGPT artifact.** MCP is the
  cross-vendor standard, so the single `/mcp` endpoint serves Claude and ChatGPT
  alike. No separate "custom GPT" packaging.

- **MCP is gated by config and off-affecting-nothing when disabled.** Like every
  other capability seam, `/mcp` is a config switch (default decided in planning),
  so instances that don't want an agent control plane simply never expose it.

## Actors

- A1. **Canvas author (org member or guest)** — the human who owns the MCP session;
  their identity, established via the existing login, scopes every tool call.
- A2. **MCP client** — Claude, ChatGPT, or any MCP-capable agent host that performs
  the OAuth connect and issues tool calls.
- A3. **The instance** — canvas-drop acting in two roles: MCP server (tools) and
  thin OAuth authorization server (login + token mint/verify).
- A4. **Upstream IdP** — the org's OIDC provider (e.g. Google) or trusted proxy that
  actually authenticates the human during the OAuth flow.

## Requirements

**MCP server & tools**

- R1. The instance exposes a remote MCP endpoint at `/mcp` using `@hono/mcp`'s
  `StreamableHTTPTransport` (`transport.handleRequest(c.req.raw)`), mounted as a
  native Hono route alongside the existing out-of-band routes (before the session
  gateway), with its own auth.
- R2. The MCP tool surface mirrors and extends the programmatic API: at minimum
  deploy (ZIP), get canvas state, list versions, rollback, unpublish, **create
  canvas**, **list the caller's canvases**, and **identity (`me`)**. Each tool is a
  thin wrapper over the same service layer the HTTP API uses — no parallel logic.
- R3. Every tool call is authorized by the OAuth-established identity, never by a
  client-asserted identity. A tool acts only on canvases the caller owns (or is
  otherwise entitled to per the existing access model); cross-owner access is
  refused with the existing error codes.
- R4. MCP exposure is governed by a config switch so an instance can run with no
  agent control plane; when disabled, `/mcp` and its metadata are not served.

**OAuth / authorization server**

- R5. canvas-drop acts as an OAuth 2.1 authorization server for MCP via
  `@hono/mcp`'s `mcpAuthRouter` + a custom `OAuthServerProvider`, advertising
  protected-resource metadata (RFC 9728) and authorization-server metadata
  (RFC 8414), and supporting PKCE and Dynamic Client Registration (RFC 7591) so
  unknown clients self-register.
- R6. The OAuth user-authentication step reuses the instance's existing login path
  (`proxy` / `oidc` / `dev`) — the human authenticates exactly as they do for the
  dashboard; no second IdP integration is introduced.
- R7. MCP access tokens are minted, stored hashed, scoped to the caller, and
  revocable, reusing the existing hashed-token pattern. Token issuance, refresh, and
  revocation follow the SDK's endpoints.
- R8. The OAuth/MCP surface honors the §12 auth invariants: identity comes only from
  the server-side auth context; spoofing and cross-canvas paths are rejected; the
  spoof-rejection paths are tested first.

**Skill & agent-facing surfaces**

- R9. The packaged skill (`skill/canvas-drop/SKILL.md` + `examples/`) gains an MCP
  section: connect-once via `/mcp` as the preferred path when supported, curl/HTTP
  retained for keyed sessionless agents. The zip allowlist still excludes secrets.
- R10. `/llms.txt` and its source (`docs/site/agents/llms.md`) advertise the MCP
  endpoint and the connect flow alongside the existing deploy guidance.
- R11. A new docs page (`docs/site/agents/mcp.md` → `/docs/agents/mcp`) documents the
  MCP endpoint, the OAuth connect flow, the tool surface, and the config switch, and
  is cross-linked from the skill, llms, and deploy-API pages.

**Marketing & status surfaces**

- R12. The marketing landing page (`apps/server/src/http/landing-page.ts`) surfaces
  the MCP + skill capability in its agent story.
- R13. README Status and the agent section reflect MCP as a shipped capability;
  BUILD_BRIEF records the new surface and config; `.env.example` documents any new
  config keys.

## Key Flows

- F1. **Connect (OAuth).** **Trigger:** user adds `https://{instance}/mcp` in their
  MCP client. The client discovers AS metadata, dynamically registers (or reuses a
  registration), and opens a browser to the instance → existing login (Google /
  proxy / dev) → consent. On approval the instance mints a scoped token; the client
  stores it and the session is live. **Covers R5, R6, R7.** No secret is pasted.

- F2. **Act (tool call).** **Trigger:** the agent invokes an MCP tool (e.g. create a
  canvas, then deploy files to it). The instance resolves the caller from the OAuth
  token, authorizes against the access model, runs the shared service logic, and
  returns a typed result. A cross-owner or disabled-capability call returns the
  existing stable error code. **Covers R2, R3, R8.**

- F3. **Fall back (curl).** **Trigger:** a sessionless/keyed agent (or one whose host
  has no MCP support) instead follows the skill's HTTP path with a per-canvas key —
  unchanged. **Covers R9.**

## Acceptance Examples

- AE1. **Covers R3, R8.** A connected agent calls a deploy tool against a canvas
  owned by a *different* user → refused with the existing cross-owner error code,
  not silently allowed; the audit log records the attempt.
- AE2. **Covers R6.** During F1, the human is taken through the *same* login the
  dashboard uses (e.g. Google in prod) — no separate credential, no second IdP.
- AE3. **Covers R4.** With MCP disabled by config, a request to `/mcp` and to the
  protected-resource metadata path is not served (behaves as not-present), and no
  OAuth endpoints are advertised.
- AE4. **Covers R5.** A first-time ChatGPT/Claude client with no prior registration
  completes Dynamic Client Registration + PKCE automatically and connects without
  the operator manually issuing a client ID.
- AE5. **Covers R2.** A `create canvas` tool call followed by a `deploy` to the
  returned canvas succeeds end-to-end within one connected session, with no
  per-canvas key handled by the agent.

## Scope Boundaries

**Deferred for later**
- CIMD (Client ID Metadata Documents), the MCP draft's emerging preferred
  client-identification mechanism — DCR is sufficient for v1; revisit when the spec
  stabilizes (target stable release 2026-07-28).
- Per-tool granular consent scopes beyond "this user's canvases" (e.g. read-only vs
  read-write token classes).

**Outside this product's identity**
- A bespoke ChatGPT "custom GPT" artifact — MCP is the cross-vendor standard; one
  server serves all hosts.
- Running a separate OAuth server (Ory Hydra / dedicated `@ory/mcp-oauth-provider`
  service) — conflicts with the single-process, config-not-code ethos. Reconsidered
  only if the thin in-app AS proves insufficient.
- Hand-rolling any OAuth or MCP protocol primitive — the SDK owns those.

## Dependencies / Assumptions

- Depends on `@hono/mcp` (v0.3+) for the Hono-native transport + OAuth router, with
  `@modelcontextprotocol/sdk` (v1.29+, MIT) as a peer for the provider interface and
  types. Both compose with the existing Hono v4 app with **no Express** — verified.
- **Spike-verified (2026-06-16):** the load-bearing unknown — can the existing login
  be the OAuth authorize step — is resolved *yes*. `@hono/mcp`'s provider
  `authorize(client, params, c)` hands a Hono `Context`, so `sessionSvc.resolveUserId(c)`
  + `/auth/login?returnTo` + the existing `hashToken` / `generateSessionToken`
  pattern map one-to-one onto what the `OAuthServerProvider` needs. No second IdP
  integration. The earlier Express-vs-Hono transport concern is moot — `@hono/mcp`
  is fully Hono-native (`StreamableHTTPTransport`, `mcpAuthRouter` returns a `Hono`).
- Assumes the prod IdP is Google (no DCR support), which is *why* canvas-drop is its
  own AS rather than a proxy. `@hono/mcp` also ships a Hono `ProxyOAuthServerProvider`,
  so a DCR-capable IdP deployment could proxy instead — a config path, not the v1 build.
- Reuses the existing hashed-token store and audit log — no new persistence concept,
  consistent with the dual-dialect schema seam.

## Outstanding Questions

**Resolve before / during planning**
- Default for the MCP config switch — on or off out of the box? (Trust-model call:
  default-off is conservative; default-on maximizes the "first-class agent" promise.)
- Token lifetime / refresh policy and whether MCP tokens are revocable from the
  dashboard alongside per-canvas keys.
- Where the OAuth client registrations + auth codes + access tokens persist — new
  table(s) vs extending `sessions`. (The login-bridge mechanism itself is
  spike-resolved; this is the storage-shape detail.)

**Deferred to planning**
- Milestone sequencing — its own milestone vs folded into the OSS-launch-readiness
  track (`docs/plans/2026-06-16-001-feat-oss-launch-readiness-plan.md`).
- Whether the dashboard grows a "Connected agents" management view (list/revoke
  MCP sessions) in v1 or later.

## Sources / Research

- `apps/dashboard/src/lib/deploy-curl.ts`, `apps/server/src/app.ts`
  (`deployApiRoutes` mount, out-of-band Bearer routes before the session gateway) —
  the existing programmatic surface the MCP tools wrap.
- `skill/canvas-drop/SKILL.md`, `docs/site/agents/skill.md`,
  `docs/site/agents/llms.md`, `apps/server/src/docs/routes.ts` (`/llms.txt`) — the
  already-shipped agent surfaces to extend.
- `apps/server/src/http/landing-page.ts` — the built marketing landing page.
- `apps/server/src/auth/oidc.ts` — existing OIDC client, basis for R6.
- [@hono/mcp](https://jsr.io/@hono/mcp) (v0.3.0) — the Hono-native MCP transport +
  OAuth router used by R1/R5; spike-confirmed to eliminate the Express seam.
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
  (v1.29.0, peer dep for the provider model),
  [MCP Authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization),
  [OAuth 2.1 for remote MCP servers (2026)](https://mcp.directory/blog/oauth-21-for-remote-mcp-servers-streamable-http-explained-2026).
