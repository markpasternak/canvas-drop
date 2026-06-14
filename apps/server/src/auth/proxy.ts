import type { Config } from "@canvas-drop/shared";
import { type JWTVerifyGetKey, jwtVerify } from "jose";
import { claimsToIdentity } from "./identity-mapping.js";
import type { AuthStrategy, ResolvedIdentity } from "./strategy.js";

/**
 * Proxy auth strategy (D16, §9.2, §12.5 — "invariant #1 lives or dies here").
 *
 * Exactly ONE trust path is active, chosen by config — they do not compose:
 *   (a) JWKS configured → verify the IAP's signed identity JWT (iss/aud/exp).
 *       The header path is disabled; a request without a valid JWT is anonymous.
 *       (Composing them would let an attacker omit the JWT to downgrade to the
 *       weaker header path.)
 *   (b) no JWKS → trust a forwarded identity header, but ONLY when the request's
 *       immediate hop is in CANVAS_DROP_TRUSTED_PROXY_IPS.
 *
 * An identity header arriving from an untrusted source is ignored and logged —
 * a client cannot become another user by setting it. The boot guard (U2) makes
 * an unguarded "trust any header" config impossible.
 *
 * @param jwks resolver from `createRemoteJWKSet` (production) or a local set
 *   (tests); `undefined` when no JWKS is configured.
 */
export function proxyStrategy(config: Config, jwks?: JWTVerifyGetKey): AuthStrategy {
  const p = config.auth.proxy;

  return {
    async resolveIdentity(c): Promise<ResolvedIdentity | null> {
      // (a) JWT trust path — cryptographic, preferred. When JWKS is configured
      // this is the ONLY path; we never fall through to header trust.
      if (jwks) {
        const token = c.req.header(p.jwtHeader);
        // Defense-in-depth (§12.5, M7): in JWKS mode the identity header is NEVER
        // honored. If one is present without a valid JWT, that's a downgrade-probe
        // shape worth logging — the request still resolves to anonymous, but an
        // operator scanning logs sees the spoof attempt, not just a bare 401. Fire
        // in BOTH the no-JWT and verify-failure paths (the failure path is the
        // dangerous case the old code logged nowhere).
        const strayIdentityHeader = c.req.header(p.emailHeader) !== undefined;
        if (!token) {
          if (strayIdentityHeader) {
            c.get("log")?.warn(
              { header: p.emailHeader },
              "identity header present without a JWT in JWKS mode — ignored (§12.5)",
            );
          }
          return null;
        }
        try {
          const { payload } = await jwtVerify(token, jwks, {
            issuer: p.jwtIssuer,
            audience: p.jwtAudience,
          });
          return claimsToIdentity(payload as Record<string, unknown>, "proxy");
        } catch (err) {
          // A verification failure (bad signature / iss / aud / expired) and a
          // JWKS-endpoint fetch failure both land here. Log so operators can tell
          // "bad token" from "IdP/JWKS down" instead of silent 401s, and flag a
          // stray identity header riding along with the failed token.
          c.get("log")?.warn(
            { err: (err as Error).message, strayIdentityHeader },
            "proxy JWT verification failed (§12.5)",
          );
          return null;
        }
      }

      // (b) trusted-hop header path (only when no JWKS is configured). Gate on the
      // socket PEER (the immediate hop), never the resolved client IP — the latter
      // is X-Forwarded-For-derived and therefore client-influenced (§12.5).
      if (p.trustedProxyIps.length > 0) {
        const email = c.req.header(p.emailHeader);
        if (email) {
          const ip = c.get("peerIp");
          if (ip && ipAllowed(ip, p.trustedProxyIps)) {
            const name = c.req.header(p.nameHeader) ?? undefined;
            return { sub: `proxy:${email.toLowerCase()}`, email, name };
          }
          c.get("log")?.warn(
            { ip, header: p.emailHeader },
            "ignored identity header from untrusted source (§12.5)",
          );
        }
      }

      return null;
    },
  };
}

/** True when `ip` falls within any of the given IPv4 CIDRs or exact addresses. */
export function ipAllowed(ip: string, ranges: readonly string[]): boolean {
  const normalized = normalizeIp(ip);
  return ranges.some((range) => matchOne(normalized, range));
}

function matchOne(ip: string, range: string): boolean {
  if (!range.includes("/")) return ip === normalizeIp(range);
  const [base, bitsStr] = range.split("/");
  const bits = Number(bitsStr);
  const ipNum = ipv4ToInt(ip);
  const baseNum = ipv4ToInt(base ?? "");
  // Reject /0 here too (config validation already blocks it) — a /0 would trust
  // every source IP and silently disable the §12.5 anti-impersonation gate.
  if (ipNum === null || baseNum === null || !Number.isInteger(bits) || bits < 1 || bits > 32) {
    return false;
  }
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function normalizeIp(ip: string): string {
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) → 127.0.0.1
  return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value << 8) | n;
  }
  return value >>> 0;
}
