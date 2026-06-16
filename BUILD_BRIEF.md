# canvas-drop — Build Brief (v1)

**Status:** Locked for build. All decisions made explicitly with the product owner (Mark Pasternak), 2026-06-13, unless marked OPEN.
**What it is:** An open-source (MIT), self-hostable platform where authenticated members of an organization create, deploy, share, and iterate on small web artifacts ("canvases") in seconds.
**Reference:** Shopify Quick (shopify.engineering/quick) and the internal artifact-hosting reference brief. This document supersedes both where they conflict. The product is deployment-agnostic and carries no organization-specific naming or branding.

---

## 1. Product thesis

People can now generate working web interfaces in minutes with AI, but there is nowhere safe and instant to put them. canvas-drop removes that friction:

1. Generate or write a small web app (often with Claude).
2. Upload it — drag a folder, paste HTML, or POST it.
3. Get a secure, unguessable URL inside your org's trust boundary.
4. Share it with colleagues.
5. Add backend capability (KV storage, files, AI, identity, realtime) with zero configuration when needed.

This is not a hosting platform. It is an organization's creation-and-sharing layer for AI-generated tools, prototypes, dashboards, demos, microsites, games, and lightweight internal apps. The strategic value is cultural as much as technical: more experiments, more working artifacts instead of screenshots and slide decks, less dependence on engineering for every small internal tool.

**The constraint is the product.** A small fixed set of primitives, done extremely well, beats a general-purpose platform. v1 optimizes for an open-source, self-hostable backend-primitives platform: the browser SDK, deploy API, and five primitives are in v1; the CLI and installable agent skill package come next.

---

## 2. Locked decisions (interview log)

Do not relitigate during build without flagging.

| # | Decision | Choice |
|---|----------|--------|
| D1 | Trust boundary | **Authenticated-org by default; explicit, owner-controlled exceptions for named outsiders and admin-blessed public links.** Recommended production uses an upstream identity-aware proxy (IAP): every request reaches the app only after Cloudflare Access, Google IAP, oauth2-proxy, or nginx+OAuth has authenticated the user; the app verifies/trusts the identity assertion it is handed (D16, §9.2). `oidc` and `dev` are explicit app-managed exceptions for self-hosters/local dev. **Two deliberate carve-outs (app-gated `oidc`/`dev` modes only — `proxy` mode requires an operator upstream carve-out): (a) an owner may invite a *named outsider* to a single canvas via an email magic-link guest identity; (b) an admin may grant specific accounts the ability to publish a canvas as a static-only public link.** Outside these, the org boundary holds. Password protection is an *additional* lock on the org-shared and public rungs (the magic link is itself the gate for invited guests). |
| D2 | URL / isolation model | **Configurable: `subdomain` or `path` mode.** Subdomain mode (`{slug}.canvases.example.com`, wildcard DNS + wildcard cert) gives full browser-origin isolation and is the recommended multi-user production config. Path mode (`host/c/{slug}/`) runs on one hostname — required for localhost and acceptable for trusted own-hosting/single-user use. Multi-user path mode is allowed only with an explicit unsafe opt-in and prominent warning because reduced isolation is real (§12.2). |
| D3 | Canvas naming | **Fully random slug** (readable-random, e.g. `quiet-otter-x7k2`). Unguessable by design; regenerable to rotate a leaked URL. No custom names in v1. |
| D4 | Visibility | **A per-canvas access ladder, owner-only by default.** One rung per canvas: `private` (owner only) → `specific_people` (a named allowlist of org members and/or invited outsiders) → `whole_org` (any authenticated org member with the link — the former "shared") → `public_link` (anyone with the link; admin-gated per account; static-only). Org-member viewers at `whole_org`/`specific_people` can use the canvas-facing APIs the app makes; invited guests get KV/files/realtime but not AI unless the owner opts in; `public_link` is static-only. Optional password and expiry are modifiers on the rung. **Access is revocable at any time (dies on the next request) and shares can carry an optional expiry.** Owners may additionally opt a shared canvas into a small gallery with metadata; there is no automatic org-wide directory in v1. |
| D5 | Deploy/edit (v1) | v1 proves the fastest paths: drag-drop folder/ZIP upload, paste-HTML quick create, and HTTP deploy API (agent-usable from day one). In-browser file manager + CodeMirror editor are the **next milestone (M5)**, now backed by a draft/explicit-publish version model on content-addressed storage (D11). CLI and installable agent skills come later. |
| D6 | Infrastructure | **Agnostic, Docker-first.** No cloud-vendor assumptions. **One application image** + composed off-the-shelf deps (§8.3); runs on any VPS/PaaS/k8s, fronted by an identity-aware proxy. Generic deploy guide in §8.4 (no specific cloud assumed). Dev = bare `npm run dev`, no containers. |
| D7 | Canvas → API auth | **Proxy-verified identity + auto canvas ID.** Canvas code carries no secrets: the *who* comes from the IAP-verified identity on the request (an app session only in `oidc`/`dev` modes); the canvas is identified from the URL (subdomain or path segment), verified server-side against `Origin` in subdomain mode. The per-canvas **secret API key is for programmatic access only** (deploy API, scripts, agents, future CLI) and must never appear in canvas files. |
| D8 | KV scoping | **Both shared and per-user:** `kv.*` (canvas-global) and `kv.user.*` (auto-scoped to current viewer). All writes attributed. |
| D9 | Stack shape | **Single Node/TypeScript server (Hono) + Vite/React SPA dashboard.** One process, one deploy. Drizzle ORM. |
| D10 | Database | **Configurable: SQLite or Postgres** behind one Drizzle schema. SQLite = localhost default and viable for small single-instance prods; Postgres = recommended production. Schema written dialect-portable (§10). |
| D11 | Versioning | **Draft + immutable published versions.** Each canvas has one mutable draft (working copy); the in-browser editor/file-manager edit the draft and autosave, creating no version. An explicit **Publish** snapshots the draft into an immutable version (keep last 10) and swaps the live pointer; one-click rollback restores a prior published version. The deploy API and folder/ZIP re-upload **publish a live version directly** (the "deploy = live" agent contract, §4.5) — the draft loop is editor-only; concurrency is last-publish-wins. Editing an old version = restore it into the draft, then republish. Storage is **content-addressed** (blobs keyed by hash), so versions and the draft are manifests over shared blobs — only changed files are ever written. |
| D12 | LLM proxy (v1) | **Anthropic-first behind a Vercel AI SDK abstraction.** v1 ships one server-side Anthropic proxy; the server boundary is shaped so OpenAI/OpenRouter/Google or another AI-SDK provider can be added later without changing canvas code. Admin-defined model allowlist, **streaming (SSE)**, **per-user + per-canvas quotas**, **usage dashboard**. Structured-output helper and multi-provider support are deferred. |
| D13 | Scale assumption | **~50–150 users per deployment.** Single instance is plenty; generous quotas; trivial cost. |
| D14 | Admin scope (v1) | **Minimal admin panel:** all-canvases list with usage, disable/takedown, model allowlist, global quota defaults. Admins bootstrapped via env (`CANVAS_DROP_ADMIN_EMAILS`). |
| D15 | Identity API | **Auth-provider basics:** id, email, name, avatar. API shaped so directory fields (team, title) can be added later without breaking canvas code. |
| D16 | Auth modes | **`AUTH_MODE = proxy | oidc | dev`.** **`proxy` (recommended prod):** an upstream identity-aware proxy authenticates and the app trusts a verified identity JWT (preferred — cryptographic) or a trusted-hop header (Cloudflare Access, Google IAP, oauth2-proxy, nginx+OAuth). **`oidc` (fallback):** built-in OIDC/Google login via `openid-client` for self-hosters with no IAP. **`dev`:** auto-logs-in a fake local user for localhost with zero setup. Allowed-email-domain check enforced by the app in every mode. |
| D17 | File storage | One abstraction, two drivers: **local filesystem** and **S3-compatible** (AWS S3, MinIO, Cloudflare R2, or any S3-compatible endpoint — endpoint-configurable). |
| D18 | Open source | **MIT license.** Org-agnostic naming and branding throughout; no telemetry/phone-home; 12-factor config via env vars; release-shaped repo hygiene (README, env.example, CONTRIBUTING, CI). Public release happens after internal pilot hardening, but v1 is built as an OSS/self-hostable product from day one. |
| D19 | Out of v1 | Data warehouse connector, CLI, agent skills, comments, automatic directory/search, custom backends, cron jobs, team/group visibility, standing external accounts / guest self-signup, multi-provider AI. *(Email-invited guests on a per-canvas allowlist and admin-gated static public links were added post-v1 — see D1/D4 and `docs/plans/2026-06-15-001-feat-canvas-sharing-access-ladder-plan.md`.)* |
| D20 | Design | Minimal neutral brand built on **scalable design tokens** (deployments can re-skin via tokens). Must feel extremely elegant, refined, precise. |
| D21 | Non-negotiables | **A small set of security invariants and good performance come first** (see §12.0 for the threat model). Right-sized for a trusted org, not a public hostile surface: subdomain mode must uphold the hard invariants; path mode's reduced isolation is documented and explicitly opted into for trusted own-hosting. Everything else stays proportionate and simple. |
| D22 | Realtime primitive (v1) | **Ephemeral pub/sub + presence, per canvas.** Each canvas gets WebSocket channels: viewers `publish`/`subscribe` to broadcast messages and see who's connected (`presence`). Messages are **not persisted** — durable state stays in KV. Same auth and access rules as the rest of the canvas API (resolved identity = who, slug = which canvas). Smallest realtime surface that makes live polls, cursors, and simple multiplayer work. |
| D23 | Share lifecycle | **Shares are revocable and optionally expiring.** Lowering a canvas's rung, removing an allowlist entry, revoking a guest invite, or hitting an expiry instantly returns the now-disallowed principal to 404 on the next request; revocation also disconnects any open realtime sockets and invalidates password-gate and guest-session cookies. A per-person allowlist (org members and email-invited guests) is supported post-v1 (D4). |
| D24 | Canvas stats | **Simple per-canvas stats, owner-visible.** Total views, unique viewers, last-viewed, a 30-day view sparkline, and primitive op counts (KV/files/AI/realtime). Derived from `usage_events`; no third-party analytics, no per-visitor tracking beyond the org identity already required. |

Open items collected in §15.

---

## 3. Site purpose

canvas-drop exists to let members of an organization publish internal web artifacts with near-zero setup.

1. Turn static or AI-generated HTML into a live, secure internal URL in under a minute.
2. Make sharing interactive ideas easier than sharing screenshots, decks, or Figma links.
3. Give non-engineers a safe place to host AI-created internal tools.
4. Provide five backend primitives (KV, files, AI, identity, realtime) so small apps need no custom infrastructure.
5. Keep everything inside the org trust boundary — login on every request, secrets never in the browser.

It replaces: ZIP files in chat, screenshots of prototypes, "can someone deploy this for me?", throwaway apps in production infra, and static docs where an interactive artifact would communicate better.

---

## 4. Strategy

Constraint-led. Build the smallest internal publishing system that makes 80% of useful artifacts possible. Deliberately stay smaller than Heroku/Vercel/Firebase/Retool.

**4.1 Zero-friction first.** Deploy without understanding cloud, CI/CD, DNS, TLS, secrets, or databases. Idea → live URL in under 60 seconds. The same principle applies to *operators*: clone repo → `npm run dev` → working instance with SQLite, local files, and dev auth, in under five minutes.

**4.2 Internal trust boundary.** Every request is authenticated through the configured org-auth mode. Recommended production uses an upstream identity-aware proxy (D1/D16), so the app receives and verifies a trusted identity assertion. `oidc` exists for self-hosters without an IAP, and `dev` exists for zero-setup localhost. This deletes whole problem classes — spam, anonymous abuse, bots, public threat models — while keeping the product posture simple: "resolve the org identity, map to a user, enforce canvas access." Unlike Shopify Quick, canvases are *private by default* (D4), so canvas content is treated as potentially sensitive.

**4.3 Static-first, API-optional.** A canvas is a folder of static files. No build step, no server-side code, ever. Backend capability comes only through the five platform primitives.

**4.4 Fixed primitives, not custom infrastructure.** v1: **KV storage, file storage, AI (Anthropic-first proxy behind a provider abstraction), identity, realtime (ephemeral pub/sub + presence).** Explicitly not: warehouse, cron, custom backends, persisted message history (D19). Realtime is deliberately the *thin* kind — broadcast and presence only; anything durable goes through KV. Get very good at saying no.

**4.5 AI agents are first-class authors.** Canvas code works zero-config (D7) so AI-generated HTML runs unmodified. The deploy API exists from day one so agents can ship without a human in the loop. SDK surface is small, predictable, documented in one agent-readable page (`/llms.txt`). The CLI and packaged agent skill are next, not required for v1.

**4.6 Owner-scoped, obscurity-supported.** Canvases belong to their creator. URLs are unguessable random slugs. Sharing is explicit, revocable, and optionally time-boxed. Password protection adds a second lock where wanted.

**4.7 Run anywhere.** Everything behind interfaces: URL mode, database, storage, auth provider. The same codebase serves a laptop, a $5 VPS, and a corporate cloud. Open-source/self-hosted adoption is a v1 product target; public repo launch can follow the internal pilot once the rough edges are gone.

---

## 5. Personas and jobs to be done

Scaled to a 50–150-person org. The platform operator and the AI agent shape v1 the most.

### 5.1 Product manager
*"When I have a product idea or workflow concept, I want stakeholders to react to a working artifact instead of debating a document."*
Needs: paste-HTML deploy, share link, password option. Success: idea → shareable prototype in minutes; fewer explanation meetings.

### 5.2 Designer
*"When I have an interaction concept, I want to share a working interface, not a static mockup."*
Needs: folder upload, fast redeploy, a viewer experience that doesn't embarrass the work. Success: critique on real interactions.

### 5.3 Engineer
*"When I need a small internal tool or debugging aid, I want to ship it without a repo, pipeline, or ops burden."*
Needs: deploy API, KV, files, identity, rollback; in-browser editing can follow once the core deploy loop is proven. Success: fewer micro-apps in production infra.

### 5.4 Ops / sales / customer-facing specialist
*"When my team has a repetitive checklist, lookup, or intake problem, I want a lightweight tool without waiting for engineering."*
Needs: paste-HTML flow (AI writes the code), forms backed by KV, file upload, AI summarization. Success: fewer manual spreadsheets.

### 5.5 Leadership stakeholder
*"When teams propose ideas, I want to open a working artifact with zero setup."*
Needs: a link that just works after login. Success: more concrete decisions.

### 5.6 Platform operator / admin
*"I need the platform to stay safe, cheap, and low-maintenance with guardrails I control — and I need to stand it up without a cloud team."*
Needs: Docker-first install, env-var config, admin panel, quotas, model allowlist, takedown, audit log, cost visibility. Success: near-zero support load, no incidents, boring cost curve.

### 5.7 AI coding agent
*"When asked to create an internal site, I need predictable conventions and a deploy command so the result works first time."*
Needs: zero-config SDK (no keys in code), one-page agent docs, deploy API with machine-readable errors. Success: first-deploy success rate; zero manual correction.

### 5.8 Self-hosting adopter *(new — open source)*
*"When I find canvas-drop on GitHub, I want a working instance in minutes and confidence it's safe to put my org's artifacts in."*
Needs: 5-minute quickstart, honest security docs (incl. path vs subdomain tradeoff and how to front the app with an IAP), no vendor lock-in, clean upgrade path. Because not every self-hoster runs an identity-aware proxy, the built-in `oidc` mode is the documented fallback so they're never forced to stand up Cloudflare Access just to try it. Success: time-to-first-deploy after `git clone`; deployments outside the first internal install.

### 5.9 Data analyst *(partially deferred)*
Live warehouse dashboards are post-v1 (D19). In v1: bundle JSON/CSV in the canvas, use KV for interactive state.

---

## 6. Feature inventory

Tags: **[v1]** · **[v1.1]** fast follow · **[later]** · **[never]** explicit non-goal.

### 6.1 Canvas lifecycle and hosting
1. Create canvas (generates slug + secret API key, shown once) [v1]
2. Random readable slug, e.g. `quiet-otter-x7k2` [v1]
3. Regenerate slug (rotate leaked URL; old URL dies) [v1]
4. URL routing per mode: `{slug}.{base}` (subdomain) or `{base}/c/{slug}/` (path), config-switched [v1]
5. HTTPS everywhere (wildcard cert in subdomain mode — terminated at the reverse proxy / IAP in front of the app) [v1]
6. Static asset serving with correct MIME types [v1]
7. `index.html` fallback at canvas root [v1]
8. SPA fallback mode (per-canvas toggle) [v1]
9. Asset caching: content-hashed immutable cache headers + ETags [v1]
10. Cache invalidation on deploy (atomic version pointer swap) [v1]
11. Immutable deploy versions, keep last 10 [v1]
12. One-click rollback [v1]
13. Version metadata: who, when, file count, total size [v1]
14. Delete canvas (soft delete, 30-day purge) [v1] [done]
15. Archive canvas (friendly "archived" page) [v1] [done — pulled forward in the canvas-management round]
16. Clone canvas [v1.1]
17. Canvas title + description (metadata, not part of URL) [v1]
18. Limits: 100 MB/canvas, 25 MB/file, 2,000 files [v1]
19. Blocked content: server-side executables served as plain text; dotfiles stripped [v1]
20. Malware scanning of uploads [later]
21. Custom subdomain names [never — conflicts with D3 obscurity]

### 6.2 Deploy and edit
1. Drag-and-drop folder upload (directory picker + drop zone) [v1]
2. ZIP upload with server-side extraction (zip-slip safe) [v1]
3. Paste-HTML quick create (textarea → live canvas in one step) [v1]
4. In-browser file manager: tree view, add, rename, delete, replace — operates on the draft [next milestone]
5. In-browser code editor (CodeMirror 6); **edits save to the mutable draft, explicit Publish creates a new immutable version** (D11) [next milestone]
6. HTTP deploy API: `PUT /v1/canvases/:id/deploy`, Bearer secret key, ZIP/tar body [v1]
7. Machine-readable deploy result (URL, version, warnings) and stable error codes [v1]
8. Deploy progress indicator [v1]
9. Pre-deploy validation with precise errors [v1]
10. Deploy history view [v1]
11. CLI (`canvas-drop deploy`, `canvas-drop list`, …) wrapping the same API [v1.1]
12. Agent skill package (Claude skill / AGENTS.md conventions) [v1.1]
13. Git-based deploy [later]
14. Build pipelines (npm install, bundlers) [never — static only]

### 6.3 Access, sharing, and protection
1. Login on every request via configured auth mode (D16) [v1]
2. Allowed-email-domain restriction, verified server-side [v1]
3. Owner-only visibility by default [v1]
4. Access ladder (D1/D4): per-canvas visibility rung — `private` (owner only) · `specific_people` (email-invited allowlist, incl. guest invites) · `whole_org` (any authenticated member with the link) · `public_link` (admin-gated shareable link); each rung gates canvas-facing APIs too [v1]
5. Revoke share (instant: non-owners → 404, open realtime sockets dropped, gate cookies invalidated) [v1]
6. Optional share expiry (timestamp; auto-revokes; owner sees countdown/expired state) [v1]
7. Per-canvas password (argon2id; gate page; scoped cookie) [v1]
8. Unguessable URLs as defense-in-depth (never the only control) [v1]
9. App-managed sessions for `oidc`/`dev`: HttpOnly Secure cookies, 14-day rolling, revocation on logout [v1]
10. View/access/API audit attribution [v1]
11. Opt-in gallery listing for explicitly shared canvases with owner-provided metadata [v1]
12. Share-to-specific-people allowlist — shipped as the `specific_people` rung with email guest invites [v1]
13. Team/group visibility [later]
14. External/anonymous access [never]

### 6.4 KV storage primitive
1. `canvasdrop.kv.get/set/delete/list` — canvas-global namespace [v1]
2. `canvasdrop.kv.user.*` — auto-scoped per viewer [v1]
3. Values: JSON, max 64 KB [v1]
4. Keys: max 512 bytes; list with prefix + pagination [v1]
5. Limits: 10,000 keys/canvas; 1,000/user-namespace [v1]
6. Atomic `kv.increment(key, by)` (polls/votes/leaderboards without races) [v1]
7. Write attribution (user id + timestamp on every write) [v1]
8. Optimistic concurrency (optional `ifRevision`) [v1.1]
9. Data export (JSON dump, owner-only) [v1.1]
10. TTL on keys [later]
11. KV change-subscriptions (auto-notify on writes) [v1.1 — realtime primitive exists in v1, but KV-backed sync is a separate, larger surface; for now canvases combine `kv.*` with the realtime primitive manually]
12. Collections/documents query API [later — only if KV proves insufficient]

### 6.5 File storage primitive
1. `canvasdrop.files.upload(file)` (size/type checked server-side) [v1]
2. `canvasdrop.files.list()` with metadata [v1]
3. `canvasdrop.files.delete(id)` [v1]
4. `canvasdrop.files.url(id)` — authenticated download URL [v1]
5. Per-canvas namespace; 1 GB/canvas; 25 MB/file [v1]
6. Upload attribution [v1]
7. Storage abstraction: local-disk driver / S3-compatible driver behind one interface [v1]
8. Image preview in dashboard file manager [v1.1]
9. Presigned URLs for large files (S3 driver) [v1.1]
10. Resumable large uploads [later]
11. Image transformation [later]

### 6.6 AI primitive (Anthropic-first LLM proxy)
1. `canvasdrop.ai.chat(messages, options)` — proxied, no keys in client [v1]
2. SSE streaming (`canvasdrop.ai.stream(...)`, async iterator) [v1]
3. **Provider-shaped interface (Vercel AI SDK):** Anthropic is the v1 supported provider; the server boundary is intentionally shaped so other AI-SDK providers can be added later without changing canvas code [v1]
4. Admin model allowlist (Anthropic model IDs in v1; provider-qualified shape reserved for later); out-of-list requests rejected [v1]
5. Per-user daily + per-canvas monthly quotas, admin-adjustable [v1]
6. Usage metering per call (canvas, user, provider, model, tokens, cost) [v1]
7. Usage dashboard: owner per-canvas; admin totals/by-user/by-canvas [v1]
8. Friendly quota-exceeded errors the canvas can render [v1]
9. Retry/backoff for upstream 429/5xx (handled uniformly by the SDK layer) [v1]
10. Structured JSON output helper (AI SDK `generateObject`) [v1.1]
11. Logging policy: metadata always, prompt/response bodies **not** logged in v1 [v1]
12. Multi-provider AI, embeddings, image gen, vision (same provider abstraction) [later]
13. User-provided API keys [never]

### 6.7 Realtime primitive (ephemeral pub/sub + presence)
1. `canvasdrop.realtime.channel(name)` → per-canvas channel handle; WebSocket under the hood [v1]
2. `channel.publish(event, data)` — broadcast to all subscribers of that channel in that canvas [v1]
3. `channel.subscribe(handler)` / `channel.unsubscribe()` — receive broadcasts [v1]
4. `channel.presence()` + join/leave events — who (identity) is currently connected, deduped per user [v1]
5. Auto-reconnect with backoff; transparent to canvas code [v1]
6. Messages are **ephemeral**: fan-out only, never stored or replayed; durable state lives in KV [v1]
7. Scoped strictly to the canvas: a socket can only join channels of the canvas that served it; cross-canvas joins impossible (same slug+origin verification as the HTTP API, §9.2) [v1]
8. Access mirrors viewing: owner-only → only owner connects; shared → any allowed member; revoke/expiry/disable/password-fail → socket refused or dropped live [v1]
9. Limits: payload ≤ 16 KB/message; default 30 connections/canvas + 100 msgs/min/user (admin-tunable, §12.3); server drops oversized/abusive sockets [v1]
10. Attribution: presence and publishes carry the sender's user id (no spoofing — id comes from the resolved identity, not the client) [v1]
11. Graceful degradation: if a deployment disables realtime (env flag), the SDK methods throw a typed, catchable error [v1]
12. Message history / replay, KV-backed sync, server-authoritative rooms [later — explicit non-goal for v1, keeps the surface thin (D22)]

### 6.8 Identity primitive
1. `canvasdrop.me()` → `{ id, email, name, avatarUrl, kind }` (`kind`: `member` | `guest`) [v1]
2. Served from resolved identity/user row — no provider calls per request [v1]
3. Shape versioned for later directory fields [v1]
4. Group membership checks [later]
5. Directory sync [later]

### 6.9 Dashboard (management app)
1. My canvases first: title, slug, URL, status, last deploy, visit sparkline, with a dominant create action [v1]
2. Create flow: name → method (drop folder / ZIP / paste HTML / "use the API") [v1]
3. Canvas detail: overview, versions, settings, usage [v1]
4. Settings: title/description, shared toggle, password, SPA fallback, regenerate slug, regenerate API key, delete [v1]
5. API key shown once; regenerate invalidates; stored hashed [v1]
6. Stats / usage tab (D24): total + unique viewers, last-viewed, 30-day view sparkline, KV ops, file storage, AI tokens/cost, peak realtime connections [v1]
7. Copy-link/open affordances everywhere sensible [v1]
8. Deliberate empty/error/loading states [v1]
9. Onboarding: first-run page with the three fastest paths to live + agent snippet [v1]
10. Keyboard-friendly, fast (SPA, optimistic UI where safe) [v1]
11. Opt-in gallery: explicitly shared canvases can appear with owner-provided title/description/tags [v1]
12. Asset file manager + editor [v1.1]
13. Search own canvases [v1.1]
14. Automatic org-wide directory/search of shared canvases [later]

### 6.10 Admin panel
1. All canvases: owner, status, size, usage, last activity [v1]
2. Disable/takedown (URL shows "disabled" page; owner sees why) [v1]
3. Model allowlist management [v1]
4. Global quota defaults [v1]
5. Restore soft-deleted canvas [v1]
6. Platform usage overview (totals, top canvases, AI spend) [v1]
7. Per-canvas/per-user quota overrides [v1.1]
8. Audit log viewer [v1.1] (log itself is v1)
9. User management (block user, view user's canvases) [v1.1]

### 6.11 Security, observability, operations
1. Append-only audit log: auth events, canvas CRUD, key/slug regen, deploys, password attempts, admin actions [v1]
2. Rate limiting per-user and per-canvas on all API classes (§12.3) [v1]
3. Security headers everywhere (§12.4) [v1]
4. Structured logging (pino) with request IDs [v1]
5. Error tracking (Sentry-compatible, optional/env-configured — no mandatory third party) [v1]
6. Health endpoint (`/healthz`) for uptime checks [v1]
7. Backup guidance + scripts: SQLite file snapshot / `pg_dump` cron / S3 versioning [v1]
8. Metrics: latency histograms, per-primitive op counts, AI spend counter [v1]
9. Incident + key-rotation runbooks (docs) [v1]
10. Dependency scanning in CI; pinned lockfile [v1]
11. Right-sized security review of the five invariants (§12.0) before broad rollout/public release; external pen-test optional [v1]

### 6.12 Open-source packaging *(new)*
1. MIT LICENSE, README with 5-minute quickstart, architecture overview, honest security model doc [v1]
2. `.env.example` covering every config var [v1]
3. Dockerfile (multi-stage, distroless-ish, non-root) + docker-compose.yml (app, reverse-proxy/IAP, Postgres; MinIO optional profile) [v1]
4. Generic, vendor-neutral deployment guide (`docs/deploy.md`) + notes on fronting with an IAP [v1]
5. CI: lint, typecheck, tests on both DB dialects, image build [v1]
6. CONTRIBUTING.md + issue templates [v1]
7. No telemetry, no phone-home, no external calls except configured providers [v1]
8. Versioned release process + migration safety between versions [v1.1]
9. Demo seed script (creates example canvases) [v1.1]

---

## 7. Feature areas → subfeatures (build map)

| Area | Subfeatures | Priority |
|------|-------------|----------|
| A. Config + abstractions | Env-config loader (zod-validated), URL-mode router, DB factory (SQLite/Postgres), storage factory (local/S3), auth-mode factory | P0 — foundation for everything |
| B. Auth gateway | Proxy identity verification (JWT/JWKS + trusted-header), optional built-in OIDC + dev stub, allowed-domains check, trusted-proxy guard (§12.5), identity→user mapping, access middleware | P0 |
| C. Canvas hosting | Slug resolution per mode, version-pointer resolution, asset streaming, MIME/caching, SPA fallback, password gate page | P0 |
| D. Deploy pipeline | Folder/ZIP ingestion, validation, version creation, paste-HTML flow, deploy API with key auth | P0 |
| E. Dashboard SPA | My-canvases first, dominant create action, create flow, detail tabs, gallery opt-in, design tokens | P0 |
| F. KV primitive | Shared + per-user namespaces, increment, limits, attribution | P1 |
| G. Files primitive | Upload/list/delete/url, quotas | P1 |
| H. AI primitive | Anthropic proxy, streaming, allowlist, quotas, metering | P1 |
| I. Identity primitive | `me()` endpoint, extensible shape | P1 (ships with F) |
| R. Realtime primitive | WebSocket gateway, per-canvas channels, publish/subscribe, presence, slug+origin scoping, connection/rate limits, revoke-drops-socket | P1 |
| J. Browser SDK | Script + ESM wrapping F–I + R, mode auto-detection, typed, agent docs | P1 |
| K. Admin panel | Canvas list, takedown, allowlist, quota defaults, usage/stats overview | P2 |
| L. Hardening & ops | Rate limits, audit, headers, monitoring, backups, security review | P0–P2 continuous |
| M. OSS packaging | Docker, compose, docs, CI matrix, license, repo hygiene | P1–P2 release readiness |

Sequencing (see §16 for the full milestone order, re-ordered 2026-06-13): A → B → C → D → E made "folder → URL" real and gave it an excellent management dashboard (M1–M4, done). **Next, an editor + draft/publish version model on content-addressed storage make iterating a canvas great (M5).** Then F, G, I + J make canvases *apps* (M6); K + L harden (M7); the gallery (M8) and AI + realtime R/H (M9) follow; deployment/ops/packaging M close out last (M10). Realtime (R) is grouped with AI rather than the first primitives batch.

---

## 8. Technology stack

Chosen for: TypeScript end-to-end, excellent AI-agent ergonomics, minimal moving parts, single-process operability, and portability across DB/storage/auth/URL configurations.

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node.js 24 LTS | Current Active LTS (June 2026); boring, supported, runs everywhere. |
| Server | **Hono** | Best-in-class TS inference, tiny, Fetch-API based; agents generate it correctly. |
| Validation | **Zod v4** (+ `@hono/zod-validator`) | One schema source for runtime + static types, including the env config. |
| ORM | **Drizzle ORM** + drizzle-kit | Thin, SQL-shaped, agent-friendly — and crucially supports **both SQLite and Postgres dialects** from one mental model. |
| Database | **SQLite (better-sqlite3, WAL mode)** or **PostgreSQL ≥ 16** — `CANVAS_DROP_DB` config | D10. SQLite default for dev; fine for small single-instance prods. Postgres recommended for production. |
| Dashboard | Vite + React 19.2 + TS, TanStack Router + Query | SPA served by the same Hono process. |
| Styling | Tailwind CSS v4 (4.3+) with a CSS-variable token layer | D20 — tokens first; deployments re-skin via tokens. |
| Editor | CodeMirror 6 | In-browser file editing, deferred to v1.1 after the core deploy loop is proven. |
| Auth | **Primary: trust an upstream identity-aware proxy** (verified header/JWT). Optional built-in OIDC via `openid-client` for deployments with no proxy; dev mode = local stub | D16. Auth is invariant-critical (§12.0); trusting a proxy makes the in-app auth surface tiny (see §9.2, §12.5). |
| AI | **Vercel AI SDK** (`ai`) + `@ai-sdk/anthropic`, server-side only | D12. One unified `streamText`/`generateText` boundary; Anthropic is the v1 supported provider, and the provider factory keeps the canvas-facing contract stable for later providers. Keys never leave the server. |
| Storage | `StorageDriver` interface → `LocalDriver` / `S3Driver` (`@aws-sdk/client-s3` with custom endpoint) | D17. One driver covers AWS S3, MinIO, Cloudflare R2, or any S3-compatible endpoint. |
| Logging | **pino** → structured JSON on stdout; correlation-ID middleware; level/format via env; no in-app log shipping (the platform collects stdout). Optional Sentry-compatible error reporting via env | §6.11, §8.5. Aggregator-agnostic (Loki/Grafana, ELK, Datadog, plain files). |
| Testing | Vitest (unit/integration, **run against both dialects in CI**), Playwright (E2E) | Dialect drift is the main portability risk. |
| Lint/format | Biome | One fast tool. |
| Repo | pnpm workspaces: `apps/server`, `apps/dashboard`, `packages/sdk`, `packages/shared` | Shared zod schemas/types across server, dashboard, SDK. |

### 8.1 Configuration surface (env, zod-validated at boot)

```bash
# Core
CANVAS_DROP_URL_MODE=path|subdomain          # path = localhost default; subdomain = recommended prod
CANVAS_DROP_BASE_URL=http://localhost:3000   # subdomain mode: https://canvases.example.com (canvases at *.canvases.example.com)
CANVAS_DROP_SESSION_SECRET=...               # 256-bit
CANVAS_DROP_ADMIN_EMAILS=mark@example.com    # bootstrap admins
CANVAS_DROP_REALTIME=on|off                  # ephemeral pub/sub + presence; default on (single-process, in-memory)
CANVAS_DROP_MCP=on|off                        # remote MCP server + its OAuth endpoints (agent control plane) at /mcp; default on
CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE=false # explicit unsafe opt-in; only for trusted own-hosting

# Database
CANVAS_DROP_DB=sqlite|postgres
CANVAS_DROP_SQLITE_PATH=./data/canvasdrop.db
CANVAS_DROP_DATABASE_URL=postgres://...

# Storage
CANVAS_DROP_STORAGE=local|s3
CANVAS_DROP_STORAGE_PATH=./data/storage
CANVAS_DROP_S3_ENDPOINT=... CANVAS_DROP_S3_BUCKET=... CANVAS_DROP_S3_REGION=... CANVAS_DROP_S3_ACCESS_KEY=... CANVAS_DROP_S3_SECRET_KEY=...

# Auth — premise: an upstream identity-aware proxy authenticates every request (§9.2, §12.5)
CANVAS_DROP_AUTH_MODE=proxy|oidc|dev          # proxy = recommended prod; dev = localhost; oidc = built-in fallback
CANVAS_DROP_ALLOWED_EMAIL_DOMAINS=example.com,example.org   # enforced by us regardless of mode
# proxy mode — how we read + trust the identity the proxy injects:
CANVAS_DROP_AUTH_PROXY_EMAIL_HEADER=X-Auth-Request-Email     # or Cf-Access-Authenticated-User-Email, X-Forwarded-Email…
CANVAS_DROP_AUTH_PROXY_NAME_HEADER=X-Auth-Request-Preferred-Username
CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL=...        # preferred: cryptographically verify the proxy's signed identity JWT
CANVAS_DROP_AUTH_PROXY_JWT_ISSUER=...          # (e.g. Cloudflare Access / oauth2-proxy); falsy → fall back to trusted-IP header trust
CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE=...        # required when verifying a signed identity JWT
CANVAS_DROP_TRUSTED_PROXY_IPS=10.0.0.0/8       # only accept identity headers from these hops; app is never exposed directly
# oidc fallback mode (no proxy available):
CANVAS_DROP_OIDC_ISSUER=... CANVAS_DROP_OIDC_CLIENT_ID=... CANVAS_DROP_OIDC_CLIENT_SECRET=...
# CANVAS_DROP_SESSION_SECRET is also used for password-gate cookies and app sessions in oidc/dev mode

# AI
CANVAS_DROP_AI_PROVIDER=anthropic              # v1 supported provider; future providers reuse the same boundary
CANVAS_DROP_AI_API_KEY=...                     # Anthropic key (server-side only)
CANVAS_DROP_AI_BASE_URL=...                    # optional: self-host/gateway/proxy endpoint override
CANVAS_DROP_AI_MODELS=claude-haiku-4-5,claude-sonnet-4-6,claude-opus-4-8  # admin panel can override
CANVAS_DROP_AI_USER_DAILY_USD=5  CANVAS_DROP_AI_CANVAS_MONTHLY_USD=50

# Logging (standard structured JSON to stdout — see §8.5)
LOG_LEVEL=info                        # fatal|error|warn|info|debug|trace
LOG_FORMAT=json                       # json (default) | pretty (human-readable dev output)
```

Dev quickstart is exactly: `cp .env.example .env && npm run dev` — defaults are `path` + `sqlite` + `local` + `dev` auth. Boot fails loudly with a precise message on invalid combinations (e.g. `proxy` auth with no JWKS URL *and* no trusted-proxy IPs, proxy JWT auth without an audience, subdomain mode with a localhost base URL, or multi-user path mode without `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE=true`).

### 8.2 URL layout per mode

| | Subdomain mode (recommended prod) | Path mode (localhost / trusted own-hosting) |
|---|---|---|
| Dashboard + management API + auth | `canvases.example.com` (`/`, `/api/...`, `/auth/...`) | `localhost:3000/` (`/api/...`, `/auth/...`) |
| Canvas content | `{slug}.canvases.example.com/*` | `localhost:3000/c/{slug}/*` |
| Canvas-facing platform API | `canvases.example.com/v1/c/{slug}/...` (CORS from `*.canvases.example.com`) | `localhost:3000/v1/c/{slug}/...` (same-origin) |
| Canvas realtime (WebSocket) | `wss://{slug}.canvases.example.com/v1/c/{slug}/realtime` (`Origin` must match slug) | `ws://localhost:3000/v1/c/{slug}/realtime` (same-origin) |
| SDK + agent docs | `{base}/sdk/v1.js`, `{base}/docs`, `{base}/llms.txt` | same |

One Hono app routes on `Host` (subdomain mode) or path prefix (path mode); the abstraction is a single `resolveRequest(req) → {role, canvasSlug?}` function so the rest of the codebase never thinks about modes.

### 8.3 Docker packaging — one app image, composed deps (D6)
**Decision: one image for *our application*, plus standard off-the-shelf images for dependencies we don't build, wired together by Compose.** Not a single mega-image, not a microservice fleet.

- **One application image** because the app *is* one process (D9): dashboard, auth handling, platform API, and canvas serving all run in the same Hono server. One image = one thing to build, version, scan, roll back, and reason about; it matches the architecture instead of fighting it. A multi-stage build produces a small, non-root runtime image. SQLite + local storage need only a mounted volume — that's the genuine single-container deployment.
- **We do *not* bake dependencies into that image.** Postgres, the reverse-proxy / identity-aware proxy, and optional MinIO are separate containers because they have different lifecycles, upgrade cadences, scaling needs, and backup stories than our code. Baking Postgres into the app image would couple data durability to app deploys and break the "swap SQLite↔Postgres by config" portability (D10). Standard images already exist and are better maintained than anything we'd bundle.
- **Why not split the app itself into multiple images?** At this scale (D13) there's nothing to gain and real cost to lose: cross-service calls, more failure modes, harder local dev, no independent-scaling benefit. The role-routed single process can still be fronted by N replicas behind the proxy later (stateless except realtime, §18) — without changing the image count.
- **docker-compose.yml:** `canvas-drop` (app) + a reverse proxy (TLS termination; **typically the identity-aware proxy too** — e.g. Caddy/nginx with an auth layer, or Cloudflare Tunnel to Cloudflare Access) + `postgres` (volume + dump cron). Optional `minio` profile for local S3 testing. Works unchanged on any VPS, Fly/Render-class PaaS, or k8s.

### 8.4 Deployment (generic)
Any Docker host: a small VPS, a PaaS, or k8s, fronted by the identity-aware proxy (§9.2, §12.5). TLS via the proxy (wildcard cert for subdomain mode). The blessed production profile is subdomain mode + proxy JWT auth + Postgres + S3-compatible storage + Anthropic. SQLite/local/path remain first-class for local dev and trusted own-hosting, with path-mode isolation caveats shown plainly. Backups: nightly `pg_dump` (or SQLite snapshot) + object-store versioning. A worked, vendor-neutral example lives in `docs/deploy.md`; cost on a single modest VPS targets **< €15/month**. *(A specific cloud reference guide is deferred — out of scope for now.)*

### 8.5 Logging (standard, aggregator-agnostic)
Logging follows widely-used conventions so it drops into whatever the operator already runs, and needs **zero app-side configuration** to be useful:
- **Structured JSON to stdout/stderr via pino.** The application never manages log files, rotation, or shipping; the platform (container runtime + log collector) captures stdout. This is the only contract that's portable across a laptop, a PaaS, and a managed log stack.
- **Hono middleware** logs every request automatically (method, path, status, duration), with health/metrics paths excluded by default, and attaches a per-request child logger so handlers just call `c.get('log').info(...)`.
- **Correlation IDs:** read from an inbound `X-Correlation-ID` / `X-Request-Id` header (or generated), propagated through the request and into background jobs, and emitted on every line — so a request can be traced end-to-end in any aggregator.
- **Config via env only** (`LOG_LEVEL`, `LOG_FORMAT=json|pretty`); `pretty` gives human-readable local output, `json` everywhere else.
- **Template-style messages** (`log.info('user {userId} fetched', { userId })`) so lines are both human-readable and structured/queryable.
- No specific aggregator is assumed or required — JSON-on-stdout is consumed equally well by Loki/Grafana, ELK, Datadog, or plain file capture. Optional Sentry-compatible error reporting is env-gated and off by default (§6.11).

---

## 9. Architecture

### 9.1 One process, role-routed
A single Hono app determines per request: dashboard, auth, platform API, or canvas content (via Host header in subdomain mode, path prefix in path mode). One deployable, one log stream. Can be split behind a proxy later without code changes.

### 9.2 Identity and canvas identification (critical to D1/D2/D7)
- **Who the user is** comes from the auth mode:
  - *`proxy` mode (recommended):* the IAP authenticates upstream and forwards identity. We trust it one of two ways — **(a) verify the proxy's signed identity JWT** against its JWKS (`CANVAS_DROP_AUTH_PROXY_JWT_*`, cryptographic, the preferred path), or **(b)** read a configured identity header (`CANVAS_DROP_AUTH_PROXY_EMAIL_HEADER`) but **only when the request arrives from a trusted hop** (`CANVAS_DROP_TRUSTED_PROXY_IPS`). The app holds **no session cookie of its own** for auth in this mode — the IAP owns the session. Identity is re-derived per request, so a proxy-side logout/expiry is honored immediately.
  - *`oidc`/`dev` modes:* the app runs the login itself and sets session cookie `__canvasdrop_session` (HttpOnly, Secure in prod, SameSite=Lax; subdomain mode `Domain=.canvases.example.com`, path mode host-only).
- The app **always** enforces the allowed-email-domain check on the resolved identity, regardless of mode (for Google via the IAP, the `hd`/email domain), and maps identity → `users` row.
- **Which canvas is calling:** the SDK derives the slug from its own location (subdomain or `/c/{slug}/` path segment) and targets `/v1/c/{slug}/...` explicitly. Server-side verification differs by mode:
  - *Subdomain mode:* `Origin` header (browser-controlled, unforgeable from JS) must match the slug in the URL → cross-canvas calls impossible.
  - *Path mode:* all canvases share one origin, so Origin can't distinguish them; the server checks `Sec-Fetch-Site`/`Referer` as best-effort. **Residual risk documented (§12.2).**
- Management API: same-origin only, no CORS, `Origin`/`Sec-Fetch-Site` validated on every state-changing route. In subdomain mode this makes it unreachable from canvas origins by browser design.
- Per-canvas password gate sets its own scoped cookie (subdomain-scoped, or path-scoped in path mode).

### 9.3 Request flow — viewing a canvas
1. Browser → canvas URL (either mode). In `proxy` mode the request has already passed the IAP; an unauthenticated user never reaches the app (the proxy bounces them to login). In `oidc`/`dev` mode the app redirects to login itself.
2. Gateway: resolve + verify identity per §9.2 (verify proxy JWT / trusted-hop header, or app session); enforce email-domain allowlist. No valid identity → 401/redirect.
3. Authorization: owner-only → 404 to non-owners (don't confirm existence). Shared **and** not revoked **and** not past expiry → proceed (owner always reaches their own canvas regardless of share state). Password set → gate page unless gate cookie valid. Revoking or expiry takes effect on the next request — no stale grants.
4. Resolve canvas → current version → stream asset from storage driver. HTML and stable filenames get `no-cache` + ETag; only content-addressed/versioned assets get immutable cache headers. Unknown path → SPA fallback if enabled, else 404.
5. View recorded async for usage stats.

### 9.4 Request flow — canvas API call (zero-config)
1. Canvas JS: `canvasdrop.kv.set('votes', 5)` → SDK auto-detects mode + slug → `fetch('{base}/v1/c/{slug}/kv/votes', { credentials: 'include' })` (cookies/headers ride the IAP automatically).
2. Proxy-verified identity (or app session in oidc/dev) authenticates the **user**; slug + mode-appropriate verification (§9.2) identifies the **canvas**.
3. Policy: canvas active, viewer allowed (same rules as viewing), rate limits, quotas.
4. Operation runs in the canvas namespace, attributed to the user. In v1, sharing is trust-first: a shared viewer can use all canvas-facing API methods the app relies on. Misuse is handled through audit/logging and org discipline, not per-method ACLs. Usage event recorded.

### 9.5 Request flow — programmatic deploy
1. `PUT {base}/v1/canvases/{id}/deploy` with `Authorization: Bearer <secret key>`, ZIP/tar body.
2. Key hash lookup → must match target canvas. Validation: size, count, zip-slip paths, blocked types.
3. New immutable version is first written to a staging prefix with a pending version row. After validation completes, the DB pointer swaps to the new ready version in one transaction. Old versions beyond 10 are pruned asynchronously so DB/storage failures never corrupt the active version.
4. Response: `{ url, version, fileCount, totalBytes, warnings: [] }`; errors carry stable `code` fields agents can repair from.

### 9.6 AI proxy flow
SDK → `/v1/c/{slug}/ai/chat` (SSE) → quota check (user daily, canvas monthly) → **Vercel AI SDK `streamText` against Anthropic** with the server-held key, model forced into the allowlist → stream chunks through → usage row with token counts and computed cost. The provider boundary is a single factory (`getModel(provider, model)`) so later providers do not change canvas code, but v1 operational support is Anthropic-first. Upstream 429/5xx: bounded retry, then a structured error the canvas can render.

### 9.7 Realtime flow (WebSocket pub/sub + presence)
1. Canvas JS: `canvasdrop.realtime.channel('room').subscribe(...)` → SDK opens `wss://.../v1/c/{slug}/realtime` with `credentials: 'include'`.
2. **Upgrade handshake is authenticated exactly like an HTTP request** before the socket opens: proxy-verified identity (or app session) identifies the **user** (§9.2); the slug (subdomain or `/c/{slug}/` segment) plus `Origin` check identifies the **canvas**. Owner-only/shared/revoked/expired/password rules are evaluated here — fail → handshake refused (no socket).
3. Connection bound to one canvas + one user for its lifetime. Channel names are namespaced under that canvas; there is no way to address another canvas's channels.
4. `publish` fans out to subscribers of the same channel **in the same canvas only**; the server stamps each message with the sender's user id (client can't forge it). Nothing is stored.
5. Authorization is re-checked on a heartbeat (default 60 s) and on any settings change: revoke, expiry, disable, password rotation, or slug regen **drops live sockets immediately**.
6. Limits enforced server-side (§12.3); offending sockets are closed with a typed close code the SDK surfaces as a catchable error. Single-process, in-memory fan-out — no broker needed at D13 scale.

---

## 10. Data model (Drizzle, dialect-portable)

Portability rules: app-generated text IDs (UUIDv7) — no DB-specific uuid types; JSON stored via Drizzle's json-mode columns (`jsonb` on Postgres, TEXT-JSON on SQLite); timestamps as integer epoch ms; no Postgres-only features (arrays, enums → text + zod). Migrations generated per dialect (`drizzle/pg`, `drizzle/sqlite`); CI runs the full test suite against both.

```
users            id (text pk) · provider_sub (unique) · email (unique) · name · avatar_url
                 is_admin · is_blocked · created_at · last_seen_at

sessions         id · user_id → users · token_hash (unique) · created_at · expires_at
                 ip · user_agent · revoked_at
                 (used for app-managed login in oidc/dev modes and for password-gate cookies; in
                  proxy mode the IAP owns the session and identity is verified per request — no app session)

canvases         id (text pk) · slug (unique, random) · title · description · owner_id → users
                 shared (bool, default false) · shared_at (nullable) · shared_expires_at (nullable)
                 gallery_listed (bool, default false) · gallery_summary · gallery_tags (json)
                 gallery_published_at (nullable)
                 password_hash (nullable, argon2id)
                 spa_fallback (bool) · api_key_hash · status (active|disabled|deleted)
                 current_version_id → versions · created_at · updated_at · deleted_at
                 (revoke = set shared=false; expiry = shared_expires_at in the past; both checked at
                  request time so access ends instantly — no separate revocation table needed in v1)

versions         id · canvas_id → canvases · number (per-canvas seq) · created_by → users
                 source (folder|zip|paste|api) · file_count · total_bytes
                 manifest (json: path → {size, hash, mime}) · created_at

kv_entries       canvas_id · scope ('shared' | user_id) · key · value (json)
                 revision · updated_by → users · updated_at
                 PK (canvas_id, scope, key)

files            id · canvas_id · filename · mime · size_bytes · storage_key
                 uploaded_by → users · created_at · deleted_at

ai_usage         id · canvas_id · user_id · model · input_tokens · output_tokens
                 cost_usd (numeric-as-text on sqlite) · status · latency_ms · created_at

usage_events     id · canvas_id · user_id · type (view|kv_op|file_op|deploy|rt_connect) · meta (json) · created_at
                 (high-volume; per-canvas stats in D24/§6.9.6 are aggregated directly from this table — no separate rollup; AI usage is metered separately in ai_usage)

-- Realtime is intentionally NOT persisted: channels, presence, and messages live in process memory
-- only. The sole realtime footprint in the DB is the rt_connect usage_event used for stats.

audit_log        id · actor_id · action · target_type · target_id · meta (json) · ip · created_at
                 (append-only by convention; Postgres deployments may additionally revoke UPDATE/DELETE)

settings         key · value (json)   — model allowlist, quota defaults, feature flags
```

Indexes: `canvases(owner_id)`, `canvases(slug)`, `kv_entries(canvas_id, scope)`, `ai_usage(canvas_id, created_at)`, `ai_usage(user_id, created_at)`, `usage_events(canvas_id, created_at)`, `audit_log(created_at)`.

---

## 11. API surface

### 11.1 Browser SDK (`packages/sdk`, served at `{base}/sdk/v1.js` + npm ESM)
Zero-config: global `canvasdrop`; no init call needed — mode and slug auto-detected from location.

```ts
canvasdrop.me(): Promise<{ id, email, name, avatarUrl, kind }>   // kind: 'member' | 'guest'

canvasdrop.kv.get(key): Promise<Json | null>
canvasdrop.kv.set(key, value): Promise<void>
canvasdrop.kv.delete(key): Promise<void>
canvasdrop.kv.list({ prefix?, cursor?, limit? }): Promise<{ entries, cursor? }>
canvasdrop.kv.increment(key, by = 1): Promise<number>
canvasdrop.kv.user.*            // same shape, scoped to current viewer

canvasdrop.files.upload(file: File): Promise<{ id, name, size, url }>
canvasdrop.files.list(): Promise<FileMeta[]>
canvasdrop.files.delete(id): Promise<void>
canvasdrop.files.url(id): string

canvasdrop.ai.chat(messages, { model?, maxTokens?, system? }): Promise<{ text, usage }>
canvasdrop.ai.stream(messages, opts): AsyncIterable<string>   // SSE under the hood

canvasdrop.realtime.channel(name): Channel               // WebSocket under the hood, auto-reconnect
  channel.publish(event, data): void                    // ephemeral broadcast to this canvas's channel
  channel.subscribe((msg) => void): void                // msg: { event, data, from: { id, name } }
  channel.unsubscribe(): void                           // stop receiving on this channel
  channel.presence(): Promise<{ id, name }[]>           // who's connected now (deduped per user)
  channel.onJoin((user) => void): void                  // user: { id, name }
  channel.onLeave((user) => void): void
  channel.onPresence((users) => void): void             // full roster on every change
  channel.close(): void
```

Errors: typed `CanvasdropError { code, status, message }` base, with `CapabilityDisabledError` / `QuotaExceededError` / `NotFoundError` / `NotAuthenticatedError` subclasses — each catchable by `instanceof` and carrying a stable `code` (M6, plan 007; name aligned to the `canvasdrop` global).

### 11.2 Platform API (session-authenticated from canvases)
`GET /v1/c/:slug/me` · `GET|PUT|DELETE /v1/c/:slug/kv/:key` (+ list, `:key/increment`, `kv/user/...`) · `POST|GET /v1/c/:slug/files` · `DELETE /v1/c/:slug/files/:id` · `GET /v1/c/:slug/files/:id/content` · `POST /v1/c/:slug/ai/chat` (SSE-capable) · `GET /v1/c/:slug/realtime` (WebSocket upgrade; authenticated at handshake, §9.7).

### 11.3 Management API (session-authenticated, same-origin only)
Canvas CRUD, settings (incl. shared toggle, **share revoke**, **share expiry**, password, SPA fallback, gallery opt-in), versions, rollback, slug regen, key regen, paste-HTML create, usage/stats queries. Admin routes (`/api/admin/...`) require `is_admin`.

### 11.4 Programmatic API (Bearer secret key)
`PUT /v1/canvases/:id/deploy` · `GET /v1/canvases/:id` · `GET /v1/canvases/:id/versions` · `POST /v1/canvases/:id/rollback`. A key operates only on its own canvas. Future CLI and agent skills are thin clients of exactly this.

### 11.5 Agent enablement (v1, cheap and high-leverage)
- `{base}/docs/*` — multi-page human docs (server-rendered, with an API reference and search); `{base}/llms.txt` — same content agent-optimized. Both public (before the auth gateway). *(Built multi-page rather than single-page — owner decision 2026-06-14; see docs/plans/2026-06-14-002-…-documentation-system-plan.md.)*
- Dashboard "Build with AI" snippet: copy-paste prompt block containing the SDK contract + deploy API + this canvas's URL and mode.
- Stable machine-readable error codes throughout.

---

## 12. Security requirements

### 12.0 Threat model (read this first)
canvas-drop runs inside a **trusted organization**: everyone reaching it has already passed org SSO, and the email-domain allowlist keeps outsiders out entirely. We are **not** defending against anonymous internet attackers or a determined malicious insider trying to breach infrastructure — that surface is mostly deleted by "login on every request" (§4.2). The design optimizes for *open and frictionless among colleagues*, guarded by a short list of **hard invariants that must never break**:

1. **No impersonation.** A user is always who the resolved identity says they are; identity (`me()`, write attribution, presence) comes from the server-side auth context, never from anything the client sends.
2. **No credential or canvas theft.** A user cannot read or steal another user's session, canvas API key, or canvas content; API keys and tokens are hashed at rest and shown once.
3. **No unauthorized access.** A canvas is reachable only by: its **owner**; at `whole_org`, any allowed org member; at `specific_people`, a principal on its allowlist (an org member, or an invited guest whose magic-link session is for *this* canvas); at `public_link`, anyone — but static-only and only while the owner account holds the admin-granted publish capability. All subject to not-revoked/not-expired and any password (only the owner is never prompted). **An admin gets no special access to canvases it doesn't own**: for another user's canvas an admin is treated as an ordinary org member — the rung applies (a non-owned `private` or unlisted `specific_people` canvas 404s for an admin too) and a password-protected rung prompts the admin like anyone else. Cross-owner admin authority is limited to the dedicated admin routes (the all-canvases list + disable/enable/restore); it never extends to canvas content, the owner management/editor surface (view/edit/deploy/settings/delete), the runtime API, or realtime. Everything else 404s; `private` and unshared content stays closed; a guest can never reach a canvas it was not invited to. Identity for an invited guest is the magic-link session (never client-asserted); an anonymous public visitor has no identity and gets no primitives.
4. **No cross-canvas reach in subdomain mode.** One canvas (or its code/SDK/socket) cannot read, write, or act on another canvas's data, files, AI quota, or realtime channels. Path mode has reduced browser isolation and is explicitly limited to local/trusted own-hosting unless the operator opts into the risk.
5. **Lifecycle is honored instantly.** Revoke, expiry, disable, delete, slug regen, key regen, rung lowering, allowlist removal, guest-invite revocation, and unpublish take effect on the next request and drop live realtime sockets (including guest sockets) — no stale grants. A guest session never outlives its invite's expiry or revocation.

Everything below serves these invariants. Beyond them we deliberately stay **simple and permissive** rather than bureaucratic: any authenticated colleague can use anything explicitly shared with them, no approval workflows, no per-primitive permission matrix, no heavyweight controls that don't defend a real invariant. Shared-viewer misuse is treated as an audited internal violation, not as a reason to make the platform hostile to normal collaboration.

### 12.1 Universal
1. **Login on every request, no exceptions** — assets, API, SDK script, WebSocket upgrade. Enforced by the configured auth mode (proxy/IAP in recommended production, app-managed OIDC/dev elsewhere); the app independently re-checks the resolved identity and the email-domain allowlist on every request (for Google via the IAP: `hd` claim *and* email domain). Trusting the proxy safely is itself a hard requirement — see §12.5.
2. **No secrets in the browser, ever**: the LLM provider key (whichever provider, D12) server-side only; canvas API key never in canvas files (docs + deploy-time lint warning if a file contains a key-shaped string).
3. **Secrets at rest**: API keys/session tokens stored hashed (SHA-256 of high-entropy tokens); canvas passwords argon2id; platform secrets via env (12-factor — operators bring their own secret store).
4. **Enumeration resistance**: owner-only canvases 404 to non-owners; slugs ≥ 64 bits entropy; no sequential IDs exposed.
5. **Input hardening**: Zod on every endpoint; zip-slip/path-traversal checks; uploads served as static bytes with safe MIME mapping (never executed or interpreted); request body limits.
6. TLS everywhere in prod; HSTS. Terminated at the reverse-proxy / IAP in front of the app (wildcard cert for subdomain mode); the app itself need not hold certificates.
7. **Dependency scanning** in CI; pinned lockfiles. Being open source, also: secret-scanning hooks, signed releases [v1.1].
8. **Audit log** for auth, CRUD, deploys, key/slug regeneration, password attempts, share/revoke/expiry/gallery changes, canvas API mutations, AI usage, realtime connects/publishes where practical, and admin actions.
9. **Share lifecycle is authoritative** (invariant 5): share state, expiry, password, disable, and delete are re-checked on every request *and* on every realtime heartbeat; there is no cached "already allowed" that outlives a revoke. Realtime handshakes run the identical authorization path as HTTP — a WebSocket can never be a back door around it.

### 12.2 Mode-specific isolation guarantees (documented in README)
- **Subdomain mode:** each canvas is its own browser origin. Canvas→management and canvas→canvas attacks are blocked by browser design (origin isolation + Origin-verified API). *This is the recommended multi-user production config.*
- **Path mode:** all canvases share one origin with each other **and the dashboard**. A malicious or XSS'd canvas could issue same-origin requests toward management APIs (mitigated by `Sec-Fetch-Site`/header checks and SameSite, but not eliminable) and could touch other canvases' client-side state. *Acceptable for localhost and trusted own-hosting. Multi-user path mode requires `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE=true`, an admin-visible warning, and docs that say the cross-canvas invariant is not as strong as subdomain mode.*

### 12.3 Rate limits and quotas (defaults, admin-tunable)
Canvas API 60 req/min/user/canvas · AI 10 req/min/user · deploys 10/min/canvas · login 5/min/IP · password-gate 5/min/user with backoff · **realtime: 30 concurrent connections/canvas, 100 messages/min/user, 16 KB/message** (drop on breach). Quotas: 100 MB/canvas assets, 1 GB/canvas files, 10k KV keys, AI **$5/user/day, $50/canvas/month** (OPEN-4).

### 12.4 Headers
Strict CSP on dashboard; canvas responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, COOP, `frame-ancestors 'none'` default (embed opt-in later).

### 12.5 Trusting the identity-aware proxy (invariant #1 lives or dies here)
Because the app trusts identity asserted upstream, the single most important control is that **only the proxy can assert it**. If a user could reach the app directly and set the identity header themselves, they'd impersonate anyone — so:
- **Prefer cryptographic trust:** verify the IAP's signed identity JWT against its JWKS (Cloudflare Access, Google IAP, and oauth2-proxy all emit one), including issuer, audience, expiry, not-before/issued-at where supplied, email claim mapping, and email verification/domain checks. This holds even if network boundaries are sloppy.
- **If using header trust instead:** the app accepts identity headers **only from `CANVAS_DROP_TRUSTED_PROXY_IPS`**, and the deployment must guarantee the app is never directly reachable (bind to a private network / the proxy is the sole ingress). The proxy must **overwrite** (not append) the identity headers so a client-supplied copy can never pass through.
- **Boot-time guard:** in `proxy` mode the app refuses to start without either a JWKS URL or a trusted-proxy IP set (§8.1), so an unguarded "trust any header" config is impossible by construction.
- **Defense in depth:** strip inbound `X-Auth-*`/identity headers at the edge of *our* trust zone; treat their presence from an untrusted source as an event worth logging.
This keeps the friendly-environment posture honest: open among colleagues, but no one can *become* another colleague.

### 12.6 Recovery and review
Backup/restore documented and drilled per driver (SQLite snapshot, pg_dump, S3 versioning). **Right-sized security review before broad rollout/public release** — a focused internal review of the five invariants (§12.0), not a mandatory third-party pen-test. Review focus: auth gateway bypass, the realtime handshake taking the same authorization path as HTTP, share revoke/expiry honored live, cross-canvas access (both modes, HTTP **and** WebSocket), key handling, upload pipeline, SSRF (none should exist — server makes no user-directed fetches), and audit usefulness for trust-first shared apps.

---

## 13. Performance requirements

1. Canvas asset TTFB **P95 < 150 ms** in-region (local driver is memory-cached; S3 driver uses warm connection reuse; CDN only if measurement demands it).
2. Platform API **P95 < 200 ms** (excluding AI upstream); AI proxy overhead **< 100 ms**, first token P95 < 1.5 s.
3. Deploy 10 MB canvas **< 10 s**; paste-HTML create **< 2 s** to live URL.
4. Dashboard LCP < 1.5 s; route transitions < 200 ms.
5. Caching: HTML and stable uploaded paths use `no-cache` + ETag; content-addressed/versioned asset URLs may use `Cache-Control: public, max-age=31536000, immutable` — redeploys are instantly visible, with no stale stable filenames.
6. KV ops are single-row composite-PK lookups — no scans; usage events written async/batched. SQLite in WAL mode handles this comfortably at D13 scale; Postgres for anything bigger.
7. Realtime: in-memory fan-out, message delivery P95 **< 50 ms** in-region; a single process holds the D13-scale connection count (hundreds) comfortably. No broker in v1; horizontal scaling would need one (noted as a known limit, §18).
8. Load test before launch: 150 concurrent users, 50 req/s mixed **plus a realtime broadcast scenario**, on a single modest VPS (reference target) — must show comfortable headroom.

## 14. Design principles (v1)

1. **Token-first**: all color/space/type/radius as CSS variables (Tailwind v4 theme). v1 ships a restrained near-monochrome palette + one accent. Any deployment re-skins via tokens, not a redesign.
2. **Typography carries the brand**: one excellent open typeface (Inter/Geist class), tight scale, generous whitespace.
3. **Extremely refined**: deliberate empty states, skeleton loading, motion ≤ 150 ms, no layout shift, dark-mode-ready tokens from day one.
4. **The dashboard is the product's proof of taste** — if canvas-drop's own UI feels precise, people trust it with their work. For an OSS project it's also the screenshot that sells the repo.
5. System pages (login, password gate, 404, archived, disabled) get the same care.

---

## 15. Open questions

| # | Question | Default if unanswered |
|---|----------|----------------------|
| OPEN-1 | Production domain for the first deployment (wildcard-capable, outside corporate DNS if needed) | Buy a dedicated domain at any registrar |
| OPEN-2 | Which identity-aware proxy fronts the first deployment (Cloudflare Access, Google IAP, oauth2-proxy, nginx+OAuth) — drives whether we verify a signed JWT or a trusted header? | Cloudflare Access (verify signed JWT) |
| OPEN-3 | Anthropic model allowlist at launch + pricing table for cost computation | One fast + one frontier model |
| OPEN-4 | AI budget numbers ($5/user/day, $50/canvas/month proposed) | Proposed defaults |
| OPEN-5 | Data retention: purge soft-deleted after 30 days; KV/files cascade on delete? | Yes, 30 days, cascade |
| OPEN-6 | Starter examples in v1 (3–5 paste-ready demos: poll, AI chat, file dropbox)? | Include 3 |
| OPEN-7 | Gallery metadata shape for opt-in shared canvases | title, description, tags |
| OPEN-8 | GitHub org/repo name and public-release timing (day one vs after internal pilot) | Public after pilot hardening |
| OPEN-9 | Error tracking default (self-hostable GlitchTip vs Sentry SaaS vs logs-only) — must stay optional for OSS | Optional env-configured, logs-only default |

---

## 16. Build sequence (8 weeks, 1–2 engineers + Mark)

This sequence was **re-ordered after dashboard core** (2026-06-13) to match where the build actually went and the owner's priorities: get *core canvas management* excellent (editor + a sane version model) before turning canvases into apps; defer AI and realtime; push deployment/ops hardening to the very end. The reasoning lives in `docs/brainstorms/2026-06-13-build-resequence-editor-version-model-requirements.md`. The whole build is **greenfield** — data is clearable, so schema/storage-layout changes need no migration pre-v1.

**M1 — Foundation (A, B, L-start). [done]** Monorepo; zod-validated config; DB factory (SQLite+Postgres) with portable schema + dual migrations; storage factory (local+S3/MinIO); URL-mode router; auth modes (dev, `proxy`/forward-auth with JWT + trusted-header verification, optional built-in OIDC); identity mapping + email-domain check; audit log; CI on both dialects.

**M2 — Hosting + deploy (C, D). [done]** Slug serving in both modes, cache strategy for arbitrary uploads, staged deploy writes, folder/ZIP ingestion + validation, paste-HTML flow, deploy API with key auth, rollback.

**M3 — Dashboard core (E). [done]** My-canvases first with a dominant create action, create flow, detail (versions, stats tab, settings incl. shared/revoke/expiry/password/gallery/slug-regen/key-regen).

**M4 — Canvas-management depth. [done — formalized retroactively]** The polish round that followed dashboard core: archive/unarchive, soft-delete purge with file/version reclaim, deploy-a-new-version from the UI + clearer version actions, settings redesign + section nav, password reveal/copy + theme-aware gate, list/overview stats (size, file count, deploy method, gallery indicator), and storage/DB perf passes. *Result: managing and iterating a canvas from the dashboard is excellent.*

**M5 — Editor + draft/publish version model. [done — PR #12]** Flip storage to **content-addressed** (blobs by hash; versions/drafts are manifests over shared blobs); introduce the **mutable draft + explicit Publish** model (D11), restore-old-version-into-draft, draft preview, refcount/mark-sweep pruning; in-browser **file manager + CodeMirror editor** over the draft (§6.2.4/5); agents/uploads still publish directly with a stale-draft notice. *Result: edit files in the browser without version spam, publish deliberately, and old versions are editable by restoring them — with no duplicated blobs.*

**M6 — Primitives (F, G, I, J). [done]** KV (shared/user/increment), files, `me()`, browser SDK with mode auto-detection + docs + llms.txt. *(Realtime moves to M9 with AI.)* *Result: canvases become apps — pasted poll/form demos persist and read identity, zero-config.*

**M7 — Admin + hardening (K, L). [done]** Admin panel (takedown/disable/restore, usage overview, quota defaults); rate limits everywhere; headers review; audit completeness; trusted-proxy/IAP verification hardening (§12.5). Lands after the primitive API surface exists so it hardens the real thing. *(Deployment, backup/restore, and load testing are deliberately NOT here — see M10.)* *Admin config later generalized into a unified Configuration view (every setting: value/source/secret-mask; DB-override the safe subset — AI key/models/quotas) so the AI provider key + model allowlist are admin-managed, not env-only.*

**M8 — Gallery. [done]** Opt-in gallery browse/listing for explicitly shared canvases with owner metadata. Needs apps worth surfacing, so it follows primitives + admin.

**M9 — AI proxy + realtime (R, H). [done]** Anthropic proxy with streaming, allowlist, quotas, metering + usage tabs; realtime ephemeral pub/sub + presence (channels/publish/subscribe with handshake auth + revoke-drops-socket), SDK additions. *Result: AI chat demo streams; a poll updates live for two users and revoking the share drops the second instantly.* *A primitives **showcase** canvas (`examples/showcase/`) exercises all five end-to-end.*

**M10 — Deployment + ops hardening + OSS packaging (M, L-finish). [next]** Docker image + compose + vendor-neutral deploy docs; backup/restore drill; load test on a single modest VPS; security review of the five invariants; README/quickstart; 3 starter examples; pilot with 10–15 colleagues. *Result: pilot running behind an IAP; repo is release-shaped.*

Post-v1 (rough order): CLI → agent skill → structured-output AI helper → clone → search → **WYSIWYG/visual HTML editing (code↔visual toggle in the editor, own milestone — deferred from M5 to avoid HTML round-trip/sanitization complexity)** → public OSS release → gallery search/browse improvements → KV change-subscriptions + realtime message history → comments → warehouse.

## 17. Success metrics

Activation: idea→live URL (< 60 s); % of pilot users deploying in week one; first-deploy success rate (incl. agent deploys via API); **operator quickstart: clone→running < 5 min**.
Adoption: weekly active creators; canvases created; % of org with ≥ 1 canvas; canvases updated after first deploy. Post-OSS-release: external deployments, stars/forks as a weak signal.
Value: canvases viewed weekly by someone other than the owner; prototypes referenced in decisions; reduction in "can someone host this?" asks.
Health: uptime; P95s vs §13; AI spend vs budget; rate-limit events; security incidents (target 0); single-VPS run cost (target < €15/month).

## 18. Risks

1. **Scope creep toward a bigger platform** → the fixed five primitives (KV, files, AI, identity, realtime) are the contract; new primitives require a written decision.
2. **Dual-dialect drift** (SQLite vs Postgres) → portable-schema rules (§10) + CI test matrix on both from week 1, not retrofitted.
3. **Path mode in multi-user prod** → honest docs, dashboard notice, and subdomain mode kept genuinely easy (wildcard TLS + auth handled by the reverse-proxy/IAP) so the secure path is the lazy path.
4. **AI-generated canvases with XSS** → origin isolation (subdomain mode) contains blast radius; private-by-default limits exposure; docs nudge `textContent` over `innerHTML`.
5. **Invisible AI cost growth** → metering + quotas + admin dashboard in v1, not later.
6. **OSS maintenance burden** → small surface (D19), no telemetry, conservative dependencies, versioned releases with migration tests.
7. **Auth gateway is the single point of failure** → keep it tiny and heavily tested; resolved-identity lookup is one indexed read.
8. **"Private by default" mutes the ecosystem effect** that made Quick magical → opt-in gallery exists in v1, but no automatic directory; revisit broader discovery after use is real.
9. **Realtime tempts scope creep and breaks single-process scaling** → keep it ephemeral pub/sub + presence only (D22), durable state in KV; in-memory fan-out is fine at D13 scale but pins the app to one process — horizontal scaling later needs a broker (Redis pub/sub or similar), called out now so it isn't a surprise. Realtime is the most likely place to accidentally rebuild a database; the [later] line in §6.7 is the contract.
