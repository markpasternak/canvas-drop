# Behind a CDN

canvas-drop runs happily behind a CDN or shared reverse-proxy (Cloudflare, Fastly,
Fly, a plain nginx/Caddy edge). Identity is cookie/OIDC-based, so a CDN hop never
weakens auth — but a **shared cache** in front of the app changes three things you must
configure: which responses may be cached, who the "client" is, and how long a restricted
canvas can linger at the edge. This page covers all three.

> **TL;DR.** Set `CANVAS_DROP_TRUSTED_PROXY_IPS` to your CDN's egress, set
> `CANVAS_DROP_CLIENT_IP_HEADER` to your CDN's real-client header, review
> `CANVAS_DROP_PUBLIC_EDGE_CACHE_TTL` (default 300s), and add a CDN cache rule that
> **only caches HTML when there is no session cookie.**

## 1. What is safe to cache

The app emits access-aware `Cache-Control` on every canvas response, so you don't have
to reason about it per canvas — just honor the origin headers:

| Response | `Cache-Control` | A shared CDN may… |
|----------|-----------------|-------------------|
| HTML of a **public** canvas (`public_link`, no password) | `public, max-age=0, s-maxage=<TTL>` | cache at the edge for the TTL; the browser still revalidates |
| HTML of any **auth-gated** canvas (private / org / specific-people / password) | `private, no-cache` | **never** store it |
| Content-hashed asset (`app.a1b2c3d4.js`) of a **public** canvas | `public, max-age=1y, immutable` | cache forever |
| Content-hashed asset of an **auth-gated** canvas | `private, max-age=1y, immutable` | **never** store it (the browser still caches) |

Only the **`public_link`, no-password** rung is reachable by an anonymous request, so
it's the only rung marked `public`. Everything else is `private` so a shared cache can't
serve one viewer's bytes to another. See [Sharing & access](../authoring/sharing) for
the rungs and the [Security model](security-model) for the isolation guarantee.

### Cloudflare specifics

- Cloudflare (like most CDNs) **does not cache HTML by default** — it caches a static
  extension allow-list. To get the offload benefit on public canvas HTML, add a **Cache
  Rule** that caches the document, and scope it to **bypass cache when a session cookie
  is present** (*Cache eligibility → Bypass cache on cookie*, matching your session
  cookie name). That cookie-bypass is belt-and-suspenders on top of the `private`
  headers: a logged-in member is never served a cached body, and an authenticated
  response never populates the edge.
- **Don't enable features that rewrite ETags.** Some optimization/compression settings
  turn a strong `ETag` into a weak `W/"…"`. The app's conditional-GET path is
  weak-ETag-tolerant, so a `304` still works either way — but it's one less surprise.

## 2. Restore the real client IP

Behind a CDN the socket peer is the CDN's edge, not your user. Left unconfigured,
**every request buckets under the CDN's IP** — login throttling becomes collateral (one
user can rate-limit everyone on the same edge) and audit logs record CDN IPs.

Two settings fix it. Both take effect **only** when the peer is a trusted hop, so a
direct caller can't spoof them:

```sh
# Your CDN's egress ranges (+ any local reverse proxy). IPv4/CIDR only; /0 is rejected.
CANVAS_DROP_TRUSTED_PROXY_IPS=173.245.48.0/20,103.21.244.0/22,127.0.0.1
# The header your CDN puts the real client IP in. Org-agnostic — name yours:
#   Cloudflare: CF-Connecting-IP (or True-Client-IP on Enterprise)
#   Fastly/Akamai: True-Client-IP    Fly.io: Fly-Client-IP
CANVAS_DROP_CLIENT_IP_HEADER=True-Client-IP
```

Without `CANVAS_DROP_CLIENT_IP_HEADER`, the app falls back to the rightmost-untrusted
`X-Forwarded-For` hop, which also works if your CDN appends a correct XFF. Keep the trust
list current — CDN egress ranges change.

This is rate-limit and audit **accuracy**, not auth: the identity-trust gate keys off the
socket peer, never a header, so a misconfigured CDN can mis-bucket a rate limit but can
never bypass authentication.

## 3. The access-downgrade staleness window

`CANVAS_DROP_PUBLIC_EDGE_CACHE_TTL` (default **300s**) is the `s-maxage` on public HTML.
It is also, by definition, **how long a CDN can keep showing a canvas after its owner
makes it private** — the cached public copy lives until it expires. The dashboard warns
owners about this in plain language whenever they restrict a public canvas (the warning
quotes this exact TTL), and the same advisory is returned by the MCP `update_canvas` tool
for agents.

Tune to taste:

- **Lower** (e.g. 60s) → near-instant access changes, less origin offload.
- **Higher** (e.g. 600s) → more offload for popular canvases, longer exposure window.
- **0** → disables shared caching (HTML stays `no-cache`); the warning is suppressed
  because there's nothing to be stale.

For a *hard* cut-over (you restricted a canvas that must come down **now**), purge that
URL at your CDN — the app can't reach into the edge cache for you.

One caveat the warning's TTL figure doesn't capture: it describes the **HTML page**.
Content-hashed sub-assets (`app.a1b2c3d4.js`) cached at the edge *while the canvas was
public* were sent with `public, immutable` and a one-year max-age, so a CDN won't
revalidate them until then. Their URLs include the content hash and aren't discoverable
without the (now-private, uncached) HTML, so the practical exposure stays the HTML
window above — but a full hard cut-over should purge the whole canvas path, not just its
root, at the CDN.

## 4. WebSockets and streaming

- **Realtime** is a real WebSocket upgrade. CDNs proxy WebSockets but drop **idle**
  connections (Cloudflare ~100s). The realtime hub heartbeats well under that, so quiet
  channels stay alive — just don't front it with a CDN that buffers or forbids upgrades.
- **The AI proxy** streams Server-Sent Events (`text/event-stream`). CDNs stream rather
  than buffer this, but make sure no optimization feature buffers the response, or
  first-token latency regresses.

## 5. Upload size

CDNs cap proxied request bodies (Cloudflare Free/Pro: **100 MB**). Canvas deploys POST
file bytes; large uploads through a proxied hostname can `413` at the edge. If that bites,
route the deploy/upload host DNS-only (un-proxied) or raise your CDN plan.

## Checklist

- [ ] `CANVAS_DROP_TRUSTED_PROXY_IPS` = CDN egress (+ local proxy)
- [ ] `CANVAS_DROP_CLIENT_IP_HEADER` = your CDN's real-client header
- [ ] `CANVAS_DROP_PUBLIC_EDGE_CACHE_TTL` reviewed (default 300s)
- [ ] CDN cache rule for HTML **bypasses cache on the session cookie**
- [ ] CDN ETag-rewriting / aggressive optimization left off
- [ ] WebSocket idle timeout > hub heartbeat; SSE not buffered
- [ ] Upload host un-proxied or within the body-size limit
