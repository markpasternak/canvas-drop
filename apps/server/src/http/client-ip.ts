import { ipAllowed } from "../auth/proxy.js";

/**
 * Resolve the REAL end-client IP for rate-limit bucketing and audit logging.
 *
 * Two different "client IPs" exist in a proxied deployment and must not be
 * conflated (§12.5):
 *   - the **socket peer** (`peerIp`) — who opened the TCP connection. Used to
 *     decide "is this request coming from my trusted proxy?" (the identity-trust
 *     gate in proxy.ts). NEVER derived from a header.
 *   - the **real client** (this function) — the human behind the proxy. Wanted
 *     for per-user login throttling and audit-log accuracy.
 *
 * `X-Forwarded-For` is consulted ONLY when the immediate hop is a configured
 * trusted proxy (`CANVAS_DROP_TRUSTED_PROXY_IPS`). Otherwise the peer IS the
 * client (or an untrusted hop we won't look behind), so we return it verbatim —
 * an untrusted caller cannot inject a fake client IP via XFF. Even in the trusted
 * case this value only keys a rate-limit bucket / audit row (never an auth
 * decision), so a worst-case wrong value mis-buckets a limit — it cannot bypass
 * auth (that lives on `peerIp` in proxy.ts).
 */
export function resolveClientIp(
  peerIp: string | undefined,
  xffHeader: string | undefined,
  trustedProxyIps: readonly string[],
): string | undefined {
  if (!peerIp) return undefined;
  // Untrusted peer (or no trust list): the peer is the client; ignore any XFF.
  if (trustedProxyIps.length === 0 || !ipAllowed(peerIp, trustedProxyIps)) return peerIp;
  if (!xffHeader) return peerIp;
  // XFF is "client, proxy1, proxy2, …" — each hop appends the address it saw, so
  // the rightmost entries are the closest (most trustworthy) proxies. Walk
  // right→left, skipping entries that are themselves trusted proxies; the first
  // untrusted address is the real client. Anything a client forged sits to the
  // LEFT of what our trusted proxy appended, so it is never reached.
  const parts = xffHeader
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const entry = parts[i];
    if (entry && !ipAllowed(entry, trustedProxyIps)) return entry;
  }
  // All entries were trusted proxies (unusual) — fall back to the peer.
  return peerIp;
}
