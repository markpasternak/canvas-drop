import type { Config } from "@canvas-drop/shared";
import { type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { AuthStrategy, ResolvedIdentity } from "./strategy.js";

/**
 * Proxy auth strategy (D16, §9.2, §12.5 — "invariant #1 lives or dies here").
 *
 * Two trust paths, in order of preference:
 *   (a) verify the IAP's signed identity JWT against its JWKS (iss/aud/exp);
 *   (b) trust a forwarded identity header, but ONLY when the request's immediate
 *       hop is in CANVAS_DROP_TRUSTED_PROXY_IPS.
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
      // (a) JWT path — cryptographic, preferred.
      if (jwks) {
        const token = c.req.header(p.jwtHeader);
        if (token) {
          try {
            const { payload } = await jwtVerify(token, jwks, {
              issuer: p.jwtIssuer,
              audience: p.jwtAudience,
            });
            return identityFromClaims(payload);
          } catch {
            // invalid signature / wrong iss or aud / expired → no identity
            return null;
          }
        }
      }

      // (b) trusted-hop header path.
      if (p.trustedProxyIps.length > 0) {
        const email = c.req.header(p.emailHeader);
        if (email) {
          const ip = c.get("clientIp");
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

function identityFromClaims(payload: JWTPayload): ResolvedIdentity | null {
  const email = typeof payload.email === "string" ? payload.email : undefined;
  if (!email) return null;
  const sub = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : email;
  const name = typeof payload.name === "string" ? payload.name : undefined;
  return { sub, email, name };
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
  if (ipNum === null || baseNum === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
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
