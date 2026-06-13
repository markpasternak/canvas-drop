import { type Config, ConfigError, loadConfig } from "@canvas-drop/shared";
import type { Context } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../http/types.js";
import { ipAllowed, proxyStrategy } from "./proxy.js";

const config: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "proxy",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvases.example.com",
  CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
  CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL: "https://idp.example.com/jwks",
  CANVAS_DROP_AUTH_PROXY_JWT_ISSUER: "https://idp.example.com",
  CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE: "canvas-drop",
  CANVAS_DROP_TRUSTED_PROXY_IPS: "10.0.0.0/8",
});
const JWT_HEADER = config.auth.proxy.jwtHeader;
const EMAIL_HEADER = config.auth.proxy.emailHeader;

/** Minimal Context stub exposing only what the strategy reads. */
function ctx(opts: { headers?: Record<string, string>; clientIp?: string }): Context<AppEnv> {
  const headers = new Headers(opts.headers ?? {});
  return {
    req: { header: (n: string) => headers.get(n) ?? undefined },
    get: (k: string) => (k === "clientIp" ? opts.clientIp : undefined),
  } as unknown as Context<AppEnv>;
}

let jwks: JWTVerifyGetKey;
let sign: (
  claims: Record<string, unknown>,
  opts?: { iss?: string; aud?: string; exp?: string | number; key?: CryptoKey },
) => Promise<string>;
let otherKey: CryptoKey;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] });
  ({ privateKey: otherKey } = await generateKeyPair("RS256"));

  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? "https://idp.example.com")
      .setAudience(opts.aud ?? "canvas-drop")
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign(opts.key ?? privateKey);
});

describe("proxyStrategy — JWT path", () => {
  it("resolves identity from a valid signed JWT", async () => {
    const token = await sign({ email: "ada@example.com", name: "Ada", sub: "abc" });
    const id = await proxyStrategy(config, jwks).resolveIdentity(
      ctx({ headers: { [JWT_HEADER]: token } }),
    );
    // sub is namespaced by trust source so identities never collide on provider_sub
    expect(id).toEqual({ sub: "proxy:abc", email: "ada@example.com", name: "Ada" });
  });

  it("rejects a JWT with the wrong audience", async () => {
    const token = await sign({ email: "ada@example.com" }, { aud: "someone-else" });
    expect(
      await proxyStrategy(config, jwks).resolveIdentity(ctx({ headers: { [JWT_HEADER]: token } })),
    ).toBeNull();
  });

  it("rejects a JWT with the wrong issuer", async () => {
    const token = await sign({ email: "ada@example.com" }, { iss: "https://evil.example" });
    expect(
      await proxyStrategy(config, jwks).resolveIdentity(ctx({ headers: { [JWT_HEADER]: token } })),
    ).toBeNull();
  });

  it("rejects an expired JWT", async () => {
    const token = await sign(
      { email: "ada@example.com" },
      { exp: Math.floor(Date.now() / 1000) - 60 },
    );
    expect(
      await proxyStrategy(config, jwks).resolveIdentity(ctx({ headers: { [JWT_HEADER]: token } })),
    ).toBeNull();
  });

  it("rejects a JWT signed by a key absent from the JWKS", async () => {
    const token = await sign({ email: "ada@example.com" }, { key: otherKey });
    expect(
      await proxyStrategy(config, jwks).resolveIdentity(ctx({ headers: { [JWT_HEADER]: token } })),
    ).toBeNull();
  });

  it("does NOT fall through to the header path when JWKS is configured (no downgrade)", async () => {
    // config has both JWKS and trustedProxyIps. With JWKS active, a request that
    // omits the JWT but supplies a trusted-hop identity header must be anonymous —
    // otherwise an attacker could downgrade to the weaker header path.
    const id = await proxyStrategy(config, jwks).resolveIdentity(
      ctx({ headers: { [EMAIL_HEADER]: "grace@example.com" }, clientIp: "10.1.2.3" }),
    );
    expect(id).toBeNull();
  });
});

// Header-only config: no JWKS, so the trusted-header path is the active trust path.
const headerOnlyConfig: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "proxy",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvases.example.com",
  CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
  CANVAS_DROP_TRUSTED_PROXY_IPS: "10.0.0.0/8",
});

describe("proxyStrategy — trusted-header path (§12.5, no JWKS)", () => {
  it("accepts an identity header from a trusted hop", async () => {
    const id = await proxyStrategy(headerOnlyConfig).resolveIdentity(
      ctx({ headers: { [EMAIL_HEADER]: "grace@example.com" }, clientIp: "10.1.2.3" }),
    );
    expect(id).toEqual({
      sub: "proxy:grace@example.com",
      email: "grace@example.com",
      name: undefined,
    });
  });

  it("ignores the same header from an untrusted source (anti-impersonation)", async () => {
    const id = await proxyStrategy(headerOnlyConfig).resolveIdentity(
      ctx({ headers: { [EMAIL_HEADER]: "grace@example.com" }, clientIp: "8.8.8.8" }),
    );
    expect(id).toBeNull();
  });

  it("ignores a client-supplied header when no client IP is known", async () => {
    const id = await proxyStrategy(headerOnlyConfig).resolveIdentity(
      ctx({ headers: { [EMAIL_HEADER]: "grace@example.com" } }),
    );
    expect(id).toBeNull();
  });
});

describe("ipAllowed", () => {
  it("matches IPv4 CIDRs and exact addresses, including v4-mapped v6", () => {
    expect(ipAllowed("10.4.5.6", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("11.0.0.1", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("::ffff:10.4.5.6", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("1.2.3.4", ["1.2.3.4"])).toBe(true);
    expect(ipAllowed("1.2.3.5", ["1.2.3.4"])).toBe(false);
  });

  it("never matches a /0 range (defense-in-depth against an all-IPs trust)", () => {
    expect(ipAllowed("8.8.8.8", ["0.0.0.0/0"])).toBe(false);
    expect(ipAllowed("10.0.0.1", ["0.0.0.0/0"])).toBe(false);
  });
});

describe("proxy boot guard (extends U2)", () => {
  it("refuses proxy mode with neither JWKS URL nor trusted proxy IPs", () => {
    expect(() =>
      loadConfig({
        CANVAS_DROP_AUTH_MODE: "proxy",
        CANVAS_DROP_URL_MODE: "subdomain",
        CANVAS_DROP_BASE_URL: "https://canvases.example.com",
        CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
        CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
      }),
    ).toThrowError(ConfigError);
  });
});
