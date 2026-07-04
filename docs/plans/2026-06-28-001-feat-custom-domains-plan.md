---
title: "feat: custom domains — point any hostname (or CNAME) at a canvas"
type: feat
status: draft
date: 2026-06-28
depth: deep
origin: owner request (Mark) — bring an external domain / CNAME to a canvas-drop canvas
covers: "Let an owner attach one or more external hostnames to a canvas so it serves on those domains, with on-demand TLS, DNS-ownership verification, and MCP/UI parity. Scoped to public canvases first; the machinery generalizes to all access levels later."
---

# feat: custom domains

## Summary

Today a canvas is reachable only at its platform host: `{slug}.canvas-drop.com`
(subdomain mode) or `/c/{slug}` (path mode). This plan lets an owner point an
**external** hostname — an apex like `coolthing.com`, a subdomain like
`promo.acme.com`, or several of them — at a canvas so it serves on that domain.

Two layers must change, and a custom hostname breaks at **both** today:

1. **Edge / TLS** — `deploy/scripts/Caddyfile` matches only `canvas-drop.com,
   *.canvas-drop.com` and gets its wildcard cert via **DNS-01** (only works for the
   `canvas-drop.com` zone we control). A foreign host matches no site block and has
   no cert.
2. **App routing** — `resolveRequest()` (`apps/server/src/routing/resolve-request.ts`)
   is a **pure, no-I/O** classifier. In subdomain mode a host that is neither the apex
   nor `*.canvas-drop.com` falls through to the **dashboard**. There is no host→canvas
   mapping.

The good news: the entire serving pipeline (`publicCanvasResolver` → `canvasAccess` →
`serveCanvas`, plus `social-preview` and screenshots) keys off a single resolved
`canvasSlug`. **If we can produce a `canvasSlug` for a foreign host, everything
downstream already works.** So the feature is: a host→canvas mapping + on-demand TLS +
an ownership-verification flow + the owner-facing surface (UI + MCP) to manage it.

### The cookie/auth boundary — why "public canvases first"

The session cookie is scoped to `canvas-drop.com`. A custom domain is a **different
registrable origin** and cannot see that cookie, and the OIDC sign-in bounce lives on
the apex. So:

- **`public_link` canvases** need no auth — `publicCanvasResolver` grants the anonymous
  principal and `serveCanvas` runs. ✅ Works on a custom domain with no extra work.
- **`private` / `whole_org` / `specific_people`** would have no session on the custom
  origin and would be denied or bounced off-domain. Generalizing to these needs
  per-domain auth (each custom domain doing its own OIDC, or a cross-origin SSO bounce),
  which is materially more work.

**Decision: gate attaching/serving a custom domain to `public_link` canvases.** The
table, resolver, and TLS machinery are identical for every access level; we just refuse
to *attach* (and, defensively, refuse to *serve*) a non-public canvas on a custom domain.
That keeps the door open to generalize later with zero rework. (See Unit 5.)

### Two hostnames → one canvas

The data model is naturally many-to-one: `host` is the PK, `canvasId` is a **non-unique**
FK. `coolthing.com` and `www.coolthing.com` both map to the same `canvasId`. One row is
flagged `isPrimary` for canonical-URL/og purposes; the others get a `<link rel="canonical">`
(and optionally a 301) so the duplicate-content/SEO story is clean.

### Why DNS alone can't pick the canvas

You asked specifically about CNAMEs pointing at a canvas-drop subdomain
(`promo.acme.com` CNAME → `myslug.canvas-drop.com`). That CNAME is convenient and
self-documenting, **but HTTP only carries the requested `Host` (`promo.acme.com`), not
the CNAME chain** — the server can't learn that the request was "meant for myslug" from
DNS. So a server-side mapping row is required regardless. The CNAME target is cosmetic;
the `custom_domains` row is authoritative.

There is one exception that needs **zero app code**, useful right now for a single domain
you control — rewrite the `Host` header at the edge. See **§ Interim (Caddy-only) path**
below; the full feature is the self-serve, abuse-resistant generalization of that trick.

---

## Design

### Data model — `custom_domains` (dual-dialect)

New table, both `schema.pg.ts` and `schema.sqlite.ts` in lockstep via the shared column
helpers, plus a generated migration per dialect (prod DB persists — additive only).

| column | type | notes |
|---|---|---|
| `host` | text PK | lowercased FQDN, e.g. `coolthing.com`. Reject apex/`*.canvas-drop.com` (anti-shadow). |
| `canvasId` | text FK → canvases.id | **non-unique** (many hosts → one canvas). `onDelete: cascade`. |
| `verified` | bool, default false | flips true only after DNS TXT proof. Gates both serving and the `ask` endpoint. |
| `verifyToken` | text | random; owner publishes it as a TXT record. |
| `isPrimary` | bool, default false | the canonical host for this canvas (og:url, `rel=canonical`). |
| `createdAt` | epochMs | |

Indexes: PK on `host`; non-unique index on `canvasId` (list a canvas's domains).

### Host → canvas, without breaking `resolveRequest` purity

`resolveRequest` is pure and is called in ~5 places independently
(`app.ts`, `public-canvas-resolver`, `screenshots/capture-resolver`, `http/social-preview`,
`http/landing-page`). Keep the lookup **out** of it:

- New `DomainResolver` interface — `resolve(host): canvasSlug | null` — backed by the
  `custom_domains` table but reading from an **in-memory cache** (a `Map<host, slug>` of
  *verified* rows), refreshed on boot and invalidated on every attach/verify/remove. This
  makes per-request resolution O(1) with no DB hit, and gives the TLS `ask` endpoint
  (below) an instant answer.
- New early middleware `customDomainResolver` (mounted **before** the gateway): for any
  host that is **not** the apex and **not** `*.canvas-drop.com`, do the cache lookup and
  `c.set("customDomainSlug", slug)` when found.
- Extend `RequestParts` with optional `customCanvasSlug`. When present and the host is
  neither apex nor a platform subdomain, `resolveRequest` returns
  `{ role: "canvas", canvasSlug }`. **Still pure** — the value is resolved upstream and
  passed in.
- The ~5 callers read `c.get("customDomainSlug")` (or a small `requestPartsFrom(c)`
  helper) and pass it through.

**Ordering invariants:** the `*.canvas-drop.com` branch runs *before* the custom-domain
branch, so a platform subdomain never touches the resolver. Hosts equal to the apex or
ending in `.canvas-drop.com` are rejected at attach time.

### Edge / TLS — on-demand TLS + an `ask` gate

The wildcard stays on DNS-01; custom domains (foreign zones) use **HTTP-01 / TLS-ALPN-01**
via Caddy **on-demand TLS**, obtained lazily on first request. The `ask` gate is
mandatory — without it, anyone pointing any hostname at our IP triggers unbounded cert
issuance and burns Let's Encrypt rate limits.

```caddyfile
{
    email mark.pasternak@gmail.com
    on_demand_tls {
        ask http://127.0.0.1:3000/internal/tls-check
    }
}

# Platform apex + wildcard — unchanged, DNS-01 wildcard cert.
canvas-drop.com, *.canvas-drop.com {
    tls { dns cloudflare {env.CLOUDFLARE_API_TOKEN} resolvers 1.1.1.1 }
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}

# Any other host: cert on demand, gated by /internal/tls-check.
https:// {
    tls { on_demand }
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

New app route `GET /internal/tls-check?domain=<host>` — unauthenticated, bound to
loopback, returns **200** iff `<host>` is a *verified* row in the cache, else **404**.
This is the single point that bounds cert issuance.

### Ownership verification (anti-hijack)

Attaching a host inserts it `verified=false` with a `verifyToken`. The owner publishes:

- the routing record (apex → **A** to the droplet IP; subdomain → **CNAME** to
  `canvas-drop.com`), and
- a TXT record `_canvas-drop-verify.<host>` = `<verifyToken>`.

A `verify_canvas_domain` action does a DNS TXT lookup; on match it flips `verified=true`,
invalidates the cache (so the `ask` endpoint + resolver pick it up), and the next request
gets a cert and serves. TXT proof prevents claiming a host you don't control and stops the
`ask` endpoint from approving random hosts merely pointed at our IP.

### Canonical URL / og / cache

- `canvasUrl()` gains an optional primary-host override so shared/MCP-returned URLs and
  `social-preview.ts` og:url use the custom domain when one is primary.
- Non-primary hosts emit `<link rel="canonical">` to the primary (and optionally 301).
- `serveCanvas` security headers (`canvasFrameAncestors`) already reference
  `config.baseUrl` for the dashboard preview iframe — unchanged; the canonical platform
  subdomain still exists and is what the dashboard frames.

### Config gate (OSS-friendly, off by default)

`CANVAS_DROP_CUSTOM_DOMAINS=off|on` (new env in `packages/shared/src/config/env.ts`,
surfaced as typed `config.customDomains.enabled`; **config is the only env reader**). Off
by default so self-hosters opt in. When off: attach routes/tools 404, the resolver
no-ops, the `ask` endpoint always 404s.

### Parity (required)

Per the **agent-native parity rule**, attaching a domain is owner-facing, so the feature
isn't done without UI **and** MCP, both wrapping the **same service layer**, carrying
`requireOwned` (non-owned id ⇒ not found, §12.0) and audit events:

- Management routes: `POST /:id/domains`, `GET /:id/domains`,
  `POST /:id/domains/:host/verify`, `DELETE /:id/domains/:host`.
- MCP tools: `add_canvas_domain`, `list_canvas_domains`, `verify_canvas_domain`,
  `remove_canvas_domain` (and `set_primary_canvas_domain` or fold primary into add).
- Dashboard: a "Domains" section in canvas settings showing host, verification status, the
  exact DNS records to add, and a Verify button.

---

## Units

> One branch / one PR for the round (autonomous mode). Local commit per unit, gates green
> (`typecheck`, `lint`, dual-dialect `test`) before the next. `/ce-code-review` before the PR.

| U | What | Depends on |
|---|---|---|
| **U1** | `custom_domains` table (both dialects) + generated migrations + schema-parity green. Repository (`CustomDomainsRepository`: `add`, `findByHost`, `listByCanvas`, `markVerified`, `setPrimary`, `remove`, `listVerifiedHosts`). | — |
| **U2** | `DomainResolver` + in-memory verified-host cache (boot load + invalidation hook). Service layer `CustomDomainService` (attach with host validation + anti-shadow + public-only gate, verify via DNS TXT, remove, set-primary), audited. | U1 |
| **U3** | Routing seam: extend `RequestParts`/`resolveRequest` with `customCanvasSlug` (pure); `customDomainResolver` early middleware; thread the resolved slug through the ~5 `resolveRequest` callers. `config.customDomains.enabled` gate. | U2 |
| **U4** | `GET /internal/tls-check` ask endpoint (loopback, cache-backed, 200/404). Caddyfile: `on_demand_tls` block + `https://` on-demand site (update `deploy/scripts/Caddyfile`; it's gitignored — also doc in `deploy/README.md`). | U2 |
| **U5** | Public-only enforcement: refuse attach for non-`public_link` canvases; defensively, the resolver/`canvasAccess` deny a custom-domain hit on a now-non-public canvas (don't fall through to org sign-in on a foreign origin). Tests for each access rung. | U2, U3 |
| **U6** | Management routes (attach/list/verify/remove/primary) wrapping `CustomDomainService`, `requireOwned` + audit. | U2 |
| **U7** | MCP tools at parity (`add_/list_/verify_/remove_canvas_domain`, primary), wrapping the **same** service. | U2, U6 |
| **U8** | Dashboard "Domains" settings section: add host, show DNS records + token, verify, list/remove, mark primary. | U6 |
| **U9** | Canonical/og polish: primary-host override in `canvasUrl()` + `social-preview.ts` og:url + `rel=canonical` on non-primary serves. | U3 |
| **U10** | Docs: `BUILD_BRIEF.md` capability note, MCP reference + `/llms.txt` + packaged skill (new tools), `deploy/README.md` custom-domain runbook, `docs/solutions/` learning (on-demand TLS + `ask` gating gotchas). | U1–U9 |

### Dependency order
U1 → U2 → {U3, U4, U6} → {U5, U7, U8} → U9 → U10. U4 (edge) and U6 (routes) parallelize
once U2 lands; U3 (routing) is the long pole for actually serving.

---

## Test scenarios (per unit, dual-dialect)

- **Routing**: verified host → `{role:canvas, canvasSlug}`; unverified host → dashboard;
  `*.canvas-drop.com` never hits the resolver; apex unchanged; reject attach of apex /
  `.canvas-drop.com` host.
- **Resolver/cache**: attach (unverified) is invisible; verify flips visibility; remove
  evicts; cache survives boot reload.
- **TLS ask**: 200 only for verified+enabled; 404 when feature off, host unknown, or
  unverified.
- **Access gate (U5)**: public canvas on custom domain serves anonymously; private /
  whole_org / specific_people on a custom domain are **denied**, not bounced to OIDC.
- **Many-to-one**: two hosts → one canvas both serve; primary drives canonical/og; others
  emit `rel=canonical`.
- **Parity/ownership**: every MCP tool refuses a non-owned id as *not found*; mirrors the
  management route; audit event emitted.
- **Verification**: TXT match flips verified; mismatch/absent leaves it false.

---

## Interim (Caddy-only) path — get ONE domain live now, zero app code

Because your new domain is also in Cloudflare, the droplet's Caddy can obtain a cert for
it via the **same DNS-01 Cloudflare challenge** (the API token needs access to that zone
too) and rewrite the `Host` header to the target canvas subdomain — so the existing
subdomain routing serves the right canvas with **no server changes**. This is the manual,
single-domain version of the full feature.

Add to `deploy/scripts/Caddyfile` (and re-push with `deploy/setup.sh config`):

```caddyfile
# <YOUR_HOST> → the <SLUG> canvas. header_up rewrites Host so the app's existing
# subdomain routing resolves it; Caddy terminates TLS via Cloudflare DNS-01.
<YOUR_HOST> {
    tls { dns cloudflare {env.CLOUDFLARE_API_TOKEN} resolvers 1.1.1.1 }
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000 {
        header_up Host <SLUG>.canvas-drop.com
    }
}
```

Caveats: the app then "thinks" it is `<SLUG>.canvas-drop.com`, so og:url / `canvasUrl`
report the platform subdomain (minor for a public canvas); works for **public** canvases
(no cross-origin cookie needed); the Cloudflare API token must have **Zone:DNS:Edit** on
the new domain's zone (mint a multi-zone token if it's a different account/zone).

---

## DNS setup in Cloudflare (worked, fill in your values)

Keep the record **DNS-only (grey cloud)** so the droplet's Caddy terminates TLS itself
(consistent with the current setup; avoids Cloudflare-origin SNI/cert complications).

**A) Apex (`coolthing.com` → a canvas):**
| Type | Name | Content | Proxy | TTL |
|---|---|---|---|---|
| A | `@` | `143.244.205.24` (droplet IP) | DNS only | Auto |
| TXT | `_canvas-drop-verify` | `<verifyToken from attach>` | — | Auto |

**B) Subdomain / CNAME (`promo.acme.com` → a canvas):**
| Type | Name | Content | Proxy | TTL |
|---|---|---|---|---|
| CNAME | `promo` | `canvas-drop.com` (or `<SLUG>.canvas-drop.com`) | DNS only | Auto |
| TXT | `_canvas-drop-verify.promo` | `<verifyToken from attach>` | — | Auto |

Then: attach the host to the canvas (UI or `add_canvas_domain`), publish the TXT, run
verify. For the **interim** Caddy path skip the TXT/attach — just add the A/CNAME above
(grey cloud) and the Caddy block, then `deploy/setup.sh config`.

> Multi-zone Cloudflare token: if the new domain is in a **different** Cloudflare zone
> than `canvas-drop.com`, the existing `CLOUDFLARE_API_TOKEN` likely can't solve DNS-01
> for it. Either mint a token scoped to **both** zones (Zone:DNS:Edit) and update
> `/etc/caddy/cloudflare.env`, or — for the full feature — rely on on-demand HTTP-01
> (no DNS token needed for foreign zones).

---

## Open items for Mark (to finalize the DNS section)

1. The exact hostname — apex (`coolthing.com`) or subdomain (`promo.acme.com`)?
2. The target canvas's current subdomain/slug on canvas-drop.
3. Is the new domain in the **same** Cloudflare account/zone setup as `canvas-drop.com`
   (one token), or separate?
4. Interim Caddy path now, the full feature, or both?
