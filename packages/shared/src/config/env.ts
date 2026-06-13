import { z } from "zod";

/**
 * Configuration surface for canvas-drop (BUILD_BRIEF.md §8.1).
 *
 * This module is the ONLY place that reads `process.env`. Every other module
 * takes a typed {@link Config}. The schema validates at boot and fails loud
 * with a precise, multi-field message on any invalid combination (§8.1,
 * §12.5).
 */

// --- small transforms -------------------------------------------------------

/** Comma-separated list → trimmed non-empty string array (default when unset). */
const csv = (def: string[] = []) =>
  z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : def,
    );

const TRUTHY = ["1", "true", "on", "yes"];
const FALSY = ["0", "false", "off", "no"];

/**
 * Strict boolean: only the recognized truthy/falsy tokens are accepted. An
 * unrecognized value fails loud rather than silently coercing to a default —
 * honoring the §8.1 fail-loud contract for operator-flippable flags.
 */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((s, ctx) => {
      if (s === undefined || s === "") return def;
      const v = s.toLowerCase();
      if (TRUTHY.includes(v)) return true;
      if (FALSY.includes(v)) return false;
      ctx.addIssue({
        code: "custom",
        message: `must be one of ${[...TRUTHY, ...FALSY].join(", ")} (got "${s}")`,
      });
      return z.NEVER;
    });

/** Numeric env var with a default, validated finite. */
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((s) => (s === undefined || s === "" ? def : Number(s)))
    .refine((n) => Number.isFinite(n), { message: "must be a number" });

const domainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

const isLocalhost = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");

/**
 * Validate a trusted-proxy entry as a sane IPv4 address or CIDR. The trusted-IP
 * gate is the §12.5 anti-impersonation control, so this rejects:
 *   - `0.0.0.0/0` and any `/0` (would trust every source IP — turns the gate off)
 *   - malformed addresses / prefix lengths
 *   - IPv6 (not yet supported by the matcher — fail loud at boot rather than
 *     silently never-matching at runtime; use the JWT trust path for IPv6)
 * Returns an error string, or null when valid.
 */
function validateTrustedProxyEntry(entry: string): string | null {
  if (entry.includes(":")) {
    return `IPv6 trusted-proxy entries are not supported yet ("${entry}"); use the JWT trust path (CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL) for IPv6 proxies`;
  }
  const [addr, prefix] = entry.split("/");
  const octets = (addr ?? "").split(".");
  if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255)) {
    return `invalid IPv4 address in trusted-proxy entry "${entry}"`;
  }
  if (prefix !== undefined) {
    const bits = Number(prefix);
    if (!Number.isInteger(bits) || bits < 1 || bits > 32) {
      return `trusted-proxy CIDR "${entry}" must use a prefix length between /1 and /32 (/0 would trust every source IP)`;
    }
  }
  return null;
}

// --- raw schema (keys are the real env var names, so error paths name the
//     exact variable to fix) -------------------------------------------------

const rawSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).optional().default("development"),

    // Core
    CANVAS_DROP_URL_MODE: z.enum(["path", "subdomain"]).optional().default("path"),
    CANVAS_DROP_BASE_URL: z.url().optional().default("http://localhost:3000"),
    CANVAS_DROP_PORT: num(3000),
    CANVAS_DROP_SESSION_SECRET: z.string().optional(),
    CANVAS_DROP_ADMIN_EMAILS: csv(),
    CANVAS_DROP_REALTIME: z.enum(["on", "off"]).optional().default("on"),
    CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE: bool(false),
    // Where the built dashboard SPA lives. Defaults (in serveSpa) to a path
    // resolved from the server module; override for non-standard layouts.
    CANVAS_DROP_DASHBOARD_DIST: z.string().optional(),

    // Rate limiting (§12.3, M7). Per-class req/min defaults; admin-tunable rate
    // limits are a follow-up (these are enforcement constants on the hot path).
    CANVAS_DROP_RATELIMIT_ENABLED: bool(true),
    CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN: num(60),
    CANVAS_DROP_RATELIMIT_AI_PER_MIN: num(10),
    CANVAS_DROP_RATELIMIT_DEPLOY_PER_MIN: num(10),
    CANVAS_DROP_RATELIMIT_MANAGEMENT_PER_MIN: num(60),
    CANVAS_DROP_RATELIMIT_LOGIN_PER_MIN: num(5),
    CANVAS_DROP_RATELIMIT_PASSWORD_GATE_PER_MIN: num(5),

    // Database
    CANVAS_DROP_DB: z.enum(["sqlite", "postgres"]).optional().default("sqlite"),
    CANVAS_DROP_SQLITE_PATH: z.string().optional().default("./data/canvasdrop.db"),
    CANVAS_DROP_DATABASE_URL: z.string().optional(),

    // Storage
    CANVAS_DROP_STORAGE: z.enum(["local", "s3"]).optional().default("local"),
    CANVAS_DROP_STORAGE_PATH: z.string().optional().default("./data/storage"),
    CANVAS_DROP_S3_ENDPOINT: z.string().optional(),
    CANVAS_DROP_S3_BUCKET: z.string().optional(),
    CANVAS_DROP_S3_REGION: z.string().optional(),
    CANVAS_DROP_S3_ACCESS_KEY: z.string().optional(),
    CANVAS_DROP_S3_SECRET_KEY: z.string().optional(),
    CANVAS_DROP_S3_FORCE_PATH_STYLE: bool(true),

    // Auth
    CANVAS_DROP_AUTH_MODE: z.enum(["proxy", "oidc", "dev"]).optional().default("dev"),
    CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: csv(),
    CANVAS_DROP_AUTH_PROXY_EMAIL_HEADER: z.string().optional().default("X-Auth-Request-Email"),
    CANVAS_DROP_AUTH_PROXY_NAME_HEADER: z
      .string()
      .optional()
      .default("X-Auth-Request-Preferred-Username"),
    CANVAS_DROP_AUTH_PROXY_JWT_HEADER: z.string().optional().default("Cf-Access-Jwt-Assertion"),
    CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL: z.url().optional(),
    CANVAS_DROP_AUTH_PROXY_JWT_ISSUER: z.string().optional(),
    CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE: z.string().optional(),
    CANVAS_DROP_TRUSTED_PROXY_IPS: csv(),
    CANVAS_DROP_OIDC_ISSUER: z.url().optional(),
    CANVAS_DROP_OIDC_CLIENT_ID: z.string().optional(),
    CANVAS_DROP_OIDC_CLIENT_SECRET: z.string().optional(),
    CANVAS_DROP_DEV_USER_EMAIL: z.email().optional().default("dev@example.com"),
    CANVAS_DROP_DEV_USER_NAME: z.string().optional().default("Dev User"),

    // AI (validated even though the AI primitive ships in a later area, so the
    // config surface stays whole — see plan KTD-7).
    CANVAS_DROP_AI_PROVIDER: z.string().optional().default("anthropic"),
    CANVAS_DROP_AI_API_KEY: z.string().optional(),
    CANVAS_DROP_AI_BASE_URL: z.url().optional(),
    CANVAS_DROP_AI_MODELS: csv(["claude-fast", "claude-smart"]),
    CANVAS_DROP_AI_USER_DAILY_USD: num(5),
    CANVAS_DROP_AI_CANVAS_MONTHLY_USD: num(50),

    // Logging
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .optional()
      .default("info"),
    LOG_FORMAT: z.enum(["json", "pretty"]).optional(),

    // Error tracking (optional, off unless configured)
    CANVAS_DROP_SENTRY_DSN: z.string().optional(),
  })
  .superRefine((r, ctx) => {
    const devMode = r.CANVAS_DROP_AUTH_MODE === "dev";
    const isProd = r.NODE_ENV === "production";

    // dev auth auto-logs-in a fake admin with zero credentials — it must never
    // run in production, where it would authenticate every anonymous request as
    // the bootstrap admin. `dev` is the schema default, so this guard is the
    // backstop against a prod deploy that forgot to set CANVAS_DROP_AUTH_MODE.
    if (devMode && isProd) {
      ctx.addIssue({
        code: "custom",
        path: ["CANVAS_DROP_AUTH_MODE"],
        message:
          "dev auth mode auto-logs-in a fake admin and must not run in production; set CANVAS_DROP_AUTH_MODE=proxy or oidc",
      });
    }

    // subdomain mode requires a real (non-localhost) base URL
    if (r.CANVAS_DROP_URL_MODE === "subdomain") {
      const host = new URL(r.CANVAS_DROP_BASE_URL).hostname;
      if (isLocalhost(host)) {
        ctx.addIssue({
          code: "custom",
          path: ["CANVAS_DROP_BASE_URL"],
          message:
            "subdomain mode requires a non-localhost base URL (e.g. https://canvases.example.com)",
        });
      }
    }

    // session secret strength: required outside dev, and always in production
    if (!devMode || isProd) {
      const secret = r.CANVAS_DROP_SESSION_SECRET;
      if (!secret || secret.length < 32) {
        ctx.addIssue({
          code: "custom",
          path: ["CANVAS_DROP_SESSION_SECRET"],
          message:
            "a session secret of at least 32 characters is required outside dev mode (and always in production)",
        });
      }
    }

    // database
    if (r.CANVAS_DROP_DB === "postgres" && !r.CANVAS_DROP_DATABASE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["CANVAS_DROP_DATABASE_URL"],
        message: "CANVAS_DROP_DATABASE_URL is required when CANVAS_DROP_DB=postgres",
      });
    }

    // storage
    if (r.CANVAS_DROP_STORAGE === "s3") {
      for (const key of [
        "CANVAS_DROP_S3_BUCKET",
        "CANVAS_DROP_S3_REGION",
        "CANVAS_DROP_S3_ACCESS_KEY",
        "CANVAS_DROP_S3_SECRET_KEY",
      ] as const) {
        if (!r[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when CANVAS_DROP_STORAGE=s3`,
          });
        }
      }
    }

    // Trusted-proxy IPs gate header-asserted identity (§12.5). Validate every
    // entry in any mode they're set: reject /0, malformed v4, and unsupported
    // v6 — a bad entry here silently disables the anti-impersonation control.
    for (const entry of r.CANVAS_DROP_TRUSTED_PROXY_IPS) {
      const err = validateTrustedProxyEntry(entry);
      if (err) {
        ctx.addIssue({ code: "custom", path: ["CANVAS_DROP_TRUSTED_PROXY_IPS"], message: err });
      }
    }

    // auth: proxy mode (§12.5 — invariant #1 lives or dies here)
    if (r.CANVAS_DROP_AUTH_MODE === "proxy") {
      const hasJwks = !!r.CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL;
      const hasTrustedIps = r.CANVAS_DROP_TRUSTED_PROXY_IPS.length > 0;
      if (!hasJwks && !hasTrustedIps) {
        ctx.addIssue({
          code: "custom",
          path: ["CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL"],
          message:
            "proxy auth requires either CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL (verify the proxy's signed identity JWT) or CANVAS_DROP_TRUSTED_PROXY_IPS (trust identity headers only from these hops) — see BUILD_BRIEF.md §12.5",
        });
      }
      if (hasJwks && !r.CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE) {
        ctx.addIssue({
          code: "custom",
          path: ["CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE"],
          message:
            "CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE is required when verifying a signed identity JWT",
        });
      }
      if (hasJwks && !r.CANVAS_DROP_AUTH_PROXY_JWT_ISSUER) {
        ctx.addIssue({
          code: "custom",
          path: ["CANVAS_DROP_AUTH_PROXY_JWT_ISSUER"],
          message:
            "CANVAS_DROP_AUTH_PROXY_JWT_ISSUER is required when verifying a signed identity JWT",
        });
      }
    }

    // auth: oidc mode
    if (r.CANVAS_DROP_AUTH_MODE === "oidc") {
      for (const key of [
        "CANVAS_DROP_OIDC_ISSUER",
        "CANVAS_DROP_OIDC_CLIENT_ID",
        "CANVAS_DROP_OIDC_CLIENT_SECRET",
      ] as const) {
        if (!r[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when CANVAS_DROP_AUTH_MODE=oidc`,
          });
        }
      }
    }

    // allowed email domains are mandatory once real auth is in play
    if (!devMode && r.CANVAS_DROP_ALLOWED_EMAIL_DOMAINS.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["CANVAS_DROP_ALLOWED_EMAIL_DOMAINS"],
        message:
          "at least one allowed email domain is required in proxy/oidc mode (the app enforces it on every request)",
      });
    }

    // multi-user path mode: real auth + path mode means several real users share
    // one origin — reduced isolation must be opted into explicitly (§12.2).
    if (
      r.CANVAS_DROP_URL_MODE === "path" &&
      !devMode &&
      !r.CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE"],
        message:
          "path mode with proxy/oidc auth is multi-user and has reduced browser isolation; set CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE=true to accept the risk, or use subdomain mode (BUILD_BRIEF.md §12.2)",
      });
    }
  })
  .transform((r) => {
    const devMode = r.CANVAS_DROP_AUTH_MODE === "dev";

    const allowedEmailDomains =
      r.CANVAS_DROP_ALLOWED_EMAIL_DOMAINS.length > 0
        ? r.CANVAS_DROP_ALLOWED_EMAIL_DOMAINS.map((d) => d.toLowerCase())
        : devMode
          ? [domainOf(r.CANVAS_DROP_DEV_USER_EMAIL)]
          : [];

    const adminEmails =
      r.CANVAS_DROP_ADMIN_EMAILS.length > 0
        ? r.CANVAS_DROP_ADMIN_EMAILS.map((e) => e.toLowerCase())
        : devMode
          ? [r.CANVAS_DROP_DEV_USER_EMAIL.toLowerCase()]
          : [];

    const logFormat = r.LOG_FORMAT ?? (r.NODE_ENV === "production" ? "json" : "pretty");

    return {
      nodeEnv: r.NODE_ENV,
      isProduction: r.NODE_ENV === "production",
      urlMode: r.CANVAS_DROP_URL_MODE,
      baseUrl: r.CANVAS_DROP_BASE_URL,
      port: r.CANVAS_DROP_PORT,
      sessionSecret: r.CANVAS_DROP_SESSION_SECRET ?? "dev-insecure-session-secret",
      adminEmails,
      realtimeEnabled: r.CANVAS_DROP_REALTIME === "on",
      allowMultiUserPathMode: r.CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE,
      dashboardDist: r.CANVAS_DROP_DASHBOARD_DIST,

      rateLimit: {
        enabled: r.CANVAS_DROP_RATELIMIT_ENABLED,
        canvasApiPerMin: r.CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN,
        aiPerMin: r.CANVAS_DROP_RATELIMIT_AI_PER_MIN,
        deployPerMin: r.CANVAS_DROP_RATELIMIT_DEPLOY_PER_MIN,
        managementPerMin: r.CANVAS_DROP_RATELIMIT_MANAGEMENT_PER_MIN,
        loginPerMin: r.CANVAS_DROP_RATELIMIT_LOGIN_PER_MIN,
        passwordGatePerMin: r.CANVAS_DROP_RATELIMIT_PASSWORD_GATE_PER_MIN,
      },

      db:
        r.CANVAS_DROP_DB === "postgres"
          ? ({ driver: "postgres", url: r.CANVAS_DROP_DATABASE_URL as string } as const)
          : ({ driver: "sqlite", path: r.CANVAS_DROP_SQLITE_PATH } as const),

      storage:
        r.CANVAS_DROP_STORAGE === "s3"
          ? ({
              driver: "s3",
              endpoint: r.CANVAS_DROP_S3_ENDPOINT,
              bucket: r.CANVAS_DROP_S3_BUCKET as string,
              region: r.CANVAS_DROP_S3_REGION as string,
              accessKey: r.CANVAS_DROP_S3_ACCESS_KEY as string,
              secretKey: r.CANVAS_DROP_S3_SECRET_KEY as string,
              forcePathStyle: r.CANVAS_DROP_S3_FORCE_PATH_STYLE,
            } as const)
          : ({ driver: "local", path: r.CANVAS_DROP_STORAGE_PATH } as const),

      auth: {
        mode: r.CANVAS_DROP_AUTH_MODE,
        allowedEmailDomains,
        proxy: {
          emailHeader: r.CANVAS_DROP_AUTH_PROXY_EMAIL_HEADER,
          nameHeader: r.CANVAS_DROP_AUTH_PROXY_NAME_HEADER,
          jwtHeader: r.CANVAS_DROP_AUTH_PROXY_JWT_HEADER,
          jwksUrl: r.CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL,
          jwtIssuer: r.CANVAS_DROP_AUTH_PROXY_JWT_ISSUER,
          jwtAudience: r.CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE,
          trustedProxyIps: r.CANVAS_DROP_TRUSTED_PROXY_IPS,
        },
        oidc: {
          issuer: r.CANVAS_DROP_OIDC_ISSUER,
          clientId: r.CANVAS_DROP_OIDC_CLIENT_ID,
          clientSecret: r.CANVAS_DROP_OIDC_CLIENT_SECRET,
        },
        dev: {
          email: r.CANVAS_DROP_DEV_USER_EMAIL,
          name: r.CANVAS_DROP_DEV_USER_NAME,
        },
      },

      ai: {
        provider: r.CANVAS_DROP_AI_PROVIDER,
        apiKey: r.CANVAS_DROP_AI_API_KEY,
        baseUrl: r.CANVAS_DROP_AI_BASE_URL,
        models: r.CANVAS_DROP_AI_MODELS,
        userDailyUsd: r.CANVAS_DROP_AI_USER_DAILY_USD,
        canvasMonthlyUsd: r.CANVAS_DROP_AI_CANVAS_MONTHLY_USD,
      },

      log: {
        level: r.LOG_LEVEL,
        format: logFormat,
      },

      sentryDsn: r.CANVAS_DROP_SENTRY_DSN,
    };
  });

/** Fully validated, typed configuration. */
export type Config = z.infer<typeof rawSchema>;

/** Thrown when the environment fails validation. Message lists every problem. */
export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `Invalid canvas-drop configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}\n\nFix the variables above (see .env.example) and restart.`,
    );
    this.name = "ConfigError";
  }
}

/**
 * Parse and validate configuration from the environment.
 *
 * @throws {ConfigError} with a precise, multi-field message on any invalid
 *   combination — the boot entrypoint catches this and exits non-zero.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = rawSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(config)";
      return `${where}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }
  return result.data;
}
