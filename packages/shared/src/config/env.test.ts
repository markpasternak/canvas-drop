import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./env.js";

/** Build a minimal env that boots in dev (the zero-config localhost default). */
const devEnv = (overrides: Record<string, string | undefined> = {}) => ({
  CANVAS_DROP_AUTH_MODE: "dev",
  ...overrides,
});

describe("loadConfig", () => {
  it("defaults an empty env to path + sqlite + local + dev", () => {
    const config = loadConfig({});
    expect(config.urlMode).toBe("path");
    expect(config.db.driver).toBe("sqlite");
    expect(config.storage.driver).toBe("local");
    expect(config.auth.mode).toBe("dev");
    expect(config.log.format).toBe("pretty"); // non-production default
  });

  it("defaults the design skin to editorial and validates the enum", () => {
    expect(loadConfig({}).designSkin).toBe("editorial");
    expect(loadConfig(devEnv({ CANVAS_DROP_DESIGN_SKIN: "workshop" })).designSkin).toBe("workshop");
    expect(() => loadConfig(devEnv({ CANVAS_DROP_DESIGN_SKIN: "neon" }))).toThrow(ConfigError);
  });

  it("apiBaseUrl defaults to baseUrl, and is overridable for a dedicated API host", () => {
    const def = loadConfig(devEnv({ CANVAS_DROP_BASE_URL: "https://canvas.example.com" }));
    expect(def.apiBaseUrl).toBe("https://canvas.example.com");

    const split = loadConfig(
      devEnv({
        CANVAS_DROP_BASE_URL: "https://canvas.example.com",
        CANVAS_DROP_API_BASE_URL: "https://api.example.com",
      }),
    );
    expect(split.apiBaseUrl).toBe("https://api.example.com");
  });

  it("defaults the rate-limit config to the §12.3 values, enabled", () => {
    const config = loadConfig({});
    expect(config.rateLimit.enabled).toBe(true);
    expect(config.rateLimit.canvasApiPerMin).toBe(120);
    expect(config.rateLimit.aiPerMin).toBe(10);
    expect(config.rateLimit.deployPerMin).toBe(10);
    expect(config.rateLimit.managementPerMin).toBe(120);
    expect(config.rateLimit.loginPerMin).toBe(10);
    expect(config.rateLimit.passwordGatePerMin).toBe(5);
  });

  it("defaults the MCP agent control plane to enabled", () => {
    expect(loadConfig({}).mcp.enabled).toBe(true);
  });

  it("disables the MCP surface when CANVAS_DROP_MCP=off", () => {
    expect(loadConfig({ CANVAS_DROP_MCP: "off" }).mcp.enabled).toBe(false);
  });

  it("rejects an invalid CANVAS_DROP_MCP value instead of coercing", () => {
    expect(() => loadConfig({ CANVAS_DROP_MCP: "yes" })).toThrow();
  });

  it("honors rate-limit overrides and the master disable flag", () => {
    const config = loadConfig({
      CANVAS_DROP_RATELIMIT_ENABLED: "false",
      CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN: "200",
    });
    expect(config.rateLimit.enabled).toBe(false);
    expect(config.rateLimit.canvasApiPerMin).toBe(200);
  });

  it("rejects a zero/negative rate-limit value at boot (fail loud, not a bricked class)", () => {
    expect(() => loadConfig({ CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN: "0" })).toThrowError(
      ConfigError,
    );
    expect(() => loadConfig({ CANVAS_DROP_RATELIMIT_MANAGEMENT_PER_MIN: "-5" })).toThrowError(
      ConfigError,
    );
  });

  it("derives dev allowed-domain and admin from the dev user email", () => {
    const config = loadConfig(devEnv({ CANVAS_DROP_DEV_USER_EMAIL: "mark@example.org" }));
    expect(config.auth.allowedEmailDomains).toEqual(["example.org"]);
    expect(config.adminEmails).toEqual(["mark@example.org"]);
    expect(config.auth.dev.email).toBe("mark@example.org");
  });

  it("rejects subdomain mode with a localhost base URL", () => {
    expect(() =>
      loadConfig({
        CANVAS_DROP_AUTH_MODE: "dev",
        CANVAS_DROP_URL_MODE: "subdomain",
        CANVAS_DROP_BASE_URL: "http://localhost:3000",
      }),
    ).toThrowError(/CANVAS_DROP_BASE_URL/);
  });

  it("rejects proxy mode with neither JWKS URL nor trusted proxy IPs (§12.5)", () => {
    try {
      loadConfig({
        CANVAS_DROP_AUTH_MODE: "proxy",
        CANVAS_DROP_URL_MODE: "subdomain",
        CANVAS_DROP_BASE_URL: "https://canvases.example.com",
        CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
        CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).problems.join("\n")).toMatch(/§12\.5|JWKS_URL/);
    }
  });

  it("rejects proxy JWT verification without an audience", () => {
    expect(() =>
      loadConfig({
        CANVAS_DROP_AUTH_MODE: "proxy",
        CANVAS_DROP_URL_MODE: "subdomain",
        CANVAS_DROP_BASE_URL: "https://canvases.example.com",
        CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
        CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
        CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL: "https://idp.example.com/jwks",
        CANVAS_DROP_AUTH_PROXY_JWT_ISSUER: "https://idp.example.com",
      }),
    ).toThrowError(/CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE/);
  });

  it("accepts proxy mode with trusted proxy IPs and a header (no JWKS)", () => {
    const config = loadConfig({
      CANVAS_DROP_AUTH_MODE: "proxy",
      CANVAS_DROP_URL_MODE: "subdomain",
      CANVAS_DROP_BASE_URL: "https://canvases.example.com",
      CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
      CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
      CANVAS_DROP_TRUSTED_PROXY_IPS: "10.0.0.0/8",
    });
    expect(config.auth.mode).toBe("proxy");
    expect(config.auth.proxy.trustedProxyIps).toEqual(["10.0.0.0/8"]);
  });

  it("rejects multi-user path mode without the explicit opt-in", () => {
    expect(() =>
      loadConfig({
        CANVAS_DROP_AUTH_MODE: "oidc",
        CANVAS_DROP_URL_MODE: "path",
        CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
        CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
        CANVAS_DROP_OIDC_ISSUER: "https://idp.example.com",
        CANVAS_DROP_OIDC_CLIENT_ID: "client",
        CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
      }),
    ).toThrowError(/CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE/);
  });

  it("parses a full Postgres + S3 + proxy(JWKS) production config", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      CANVAS_DROP_AUTH_MODE: "proxy",
      CANVAS_DROP_URL_MODE: "subdomain",
      CANVAS_DROP_BASE_URL: "https://canvases.example.com",
      CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
      CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com,example.org",
      CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL: "https://idp.example.com/jwks",
      CANVAS_DROP_AUTH_PROXY_JWT_ISSUER: "https://idp.example.com",
      CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE: "canvas-drop",
      CANVAS_DROP_DB: "postgres",
      CANVAS_DROP_DATABASE_URL: "postgres://u:p@db:5432/canvasdrop",
      CANVAS_DROP_STORAGE: "s3",
      CANVAS_DROP_S3_BUCKET: "canvases",
      CANVAS_DROP_S3_REGION: "us-east-1",
      CANVAS_DROP_S3_ACCESS_KEY: "ak",
      CANVAS_DROP_S3_SECRET_KEY: "sk",
    });
    expect(config.db.driver).toBe("postgres");
    if (config.db.driver === "postgres") expect(config.db.url).toContain("postgres://");
    expect(config.storage.driver).toBe("s3");
    expect(config.auth.allowedEmailDomains).toEqual(["example.com", "example.org"]);
    expect(config.log.format).toBe("json"); // production default
  });

  it("refuses dev auth mode in production (no anonymous-admin in prod)", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        CANVAS_DROP_AUTH_MODE: "dev",
        CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
      }),
    ).toThrowError(/CANVAS_DROP_AUTH_MODE/);
  });

  it("rejects a /0 trusted-proxy CIDR (would trust every source IP)", () => {
    expect(() =>
      loadConfig({
        CANVAS_DROP_AUTH_MODE: "proxy",
        CANVAS_DROP_URL_MODE: "subdomain",
        CANVAS_DROP_BASE_URL: "https://canvases.example.com",
        CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
        CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
        CANVAS_DROP_TRUSTED_PROXY_IPS: "0.0.0.0/0",
      }),
    ).toThrowError(/CANVAS_DROP_TRUSTED_PROXY_IPS/);
  });

  it("rejects an IPv6 trusted-proxy entry with a clear message (fail loud, not silent)", () => {
    expect(() =>
      loadConfig({
        CANVAS_DROP_AUTH_MODE: "proxy",
        CANVAS_DROP_URL_MODE: "subdomain",
        CANVAS_DROP_BASE_URL: "https://canvases.example.com",
        CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
        CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
        CANVAS_DROP_TRUSTED_PROXY_IPS: "::1",
      }),
    ).toThrowError(/IPv6/);
  });

  it("rejects a typo'd boolean env value instead of silently coercing to false", () => {
    expect(() => loadConfig(devEnv({ CANVAS_DROP_S3_FORCE_PATH_STYLE: "tru" }))).toThrowError(
      /CANVAS_DROP_S3_FORCE_PATH_STYLE/,
    );
  });

  it("reports every failing field at once, not just the first", () => {
    try {
      loadConfig({
        CANVAS_DROP_AUTH_MODE: "oidc",
        CANVAS_DROP_URL_MODE: "subdomain",
        CANVAS_DROP_BASE_URL: "http://localhost:3000", // invalid for subdomain
        // missing: session secret, allowed domains, oidc issuer/client/secret
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems;
      expect(problems.length).toBeGreaterThanOrEqual(4);
      const joined = problems.join("\n");
      expect(joined).toMatch(/CANVAS_DROP_BASE_URL/);
      expect(joined).toMatch(/CANVAS_DROP_SESSION_SECRET/);
      expect(joined).toMatch(/CANVAS_DROP_OIDC_ISSUER/);
    }
  });
});
