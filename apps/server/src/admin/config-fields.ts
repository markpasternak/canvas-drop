import { type Config, SKIN_NAMES } from "@canvas-drop/shared";
import { MAX_CANVAS_BYTES, MAX_FILE_BYTES } from "../canvas/files-service.js";
import { KV_MAX_KEYS_SHARED, KV_MAX_KEYS_USER } from "../routes/canvas-kv.js";

/**
 * Config registry — the single source of truth for the admin Configuration view
 * (§6.10, this round). Every setting is one descriptor: where it comes from in
 * the environment, whether it's a secret (masked, never serialized raw), whether
 * it's editable at runtime (a DB override layered over env), and how to read its
 * boot value off the typed {@link Config}.
 *
 * Resolution is uniform for every field: **DB override (editable only) ?? env ??
 * built-in default**. Read-only fields are shown for transparency but only the
 * environment can set them (a web panel must not flip auth mode / DB driver / a
 * session secret — that would be a lockout or security footgun).
 */

export type ConfigGroup =
  | "Core"
  | "AI"
  | "Email"
  | "Limits"
  | "Access"
  | "Auth"
  | "Database"
  | "Storage"
  | "Logging";

export type ConfigType = "string" | "number" | "boolean" | "enum" | "csv";

interface ConfigFieldBase {
  /** Stable internal id (also the dashboard row key). */
  key: string;
  /** The env var that sets this (shown in the view; used for source attribution). */
  env: string;
  group: ConfigGroup;
  label: string;
  help?: string;
  type: ConfigType;
  /** Masked everywhere: never serialized raw, only `{ set, last4 }`. */
  secret: boolean;
  enumValues?: readonly string[];
  /** The boot value (env ?? default), read off the typed Config. */
  fromConfig: (c: Config) => unknown;
}

/**
 * A config field, as a discriminated union on `editable` so the editable↔settingKey
 * invariant is structural (compile-time), not just a runtime throw in
 * setConfigOverride: an editable field MUST carry a `settingKey`; a read-only field
 * MUST NOT. Adding an editable field without its store key is now a type error.
 */
export type ConfigField =
  | (ConfigFieldBase & {
      /** Runtime-editable via a DB override. */
      editable: true;
      /** Settings-store key for the DB override (required for editable fields). */
      settingKey: string;
    })
  | (ConfigFieldBase & {
      /** Read-only (env/default only). */
      editable: false;
      settingKey?: never;
    });

const csv = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

export const CONFIG_FIELDS: readonly ConfigField[] = [
  // ── Core ────────────────────────────────────────────────────────────────
  {
    key: "core.urlMode",
    env: "CANVAS_DROP_URL_MODE",
    group: "Core",
    label: "URL mode",
    type: "enum",
    enumValues: ["path", "subdomain"],
    secret: false,
    editable: false,
    fromConfig: (c) => c.urlMode,
  },
  {
    key: "core.baseUrl",
    env: "CANVAS_DROP_BASE_URL",
    group: "Core",
    label: "Base URL",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.baseUrl,
  },
  {
    key: "core.designSkin",
    env: "CANVAS_DROP_DESIGN_SKIN",
    group: "Core",
    label: "Design skin",
    help: "Instance-wide visual design language. editorial is the default; studio (warm editorial), workshop (developer/IDE), and canvas (playful/bold) are alternates. Applies to the dashboard, editor, and landing page.",
    type: "enum",
    enumValues: SKIN_NAMES,
    secret: false,
    editable: true,
    settingKey: "config.core.designSkin",
    fromConfig: (c) => c.designSkin,
  },
  {
    key: "core.apiBaseUrl",
    env: "CANVAS_DROP_API_BASE_URL",
    group: "Core",
    label: "API base URL",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.apiBaseUrl,
  },
  {
    key: "core.port",
    env: "CANVAS_DROP_PORT",
    group: "Core",
    label: "Port",
    type: "number",
    secret: false,
    editable: false,
    fromConfig: (c) => c.port,
  },
  {
    key: "core.nodeEnv",
    env: "NODE_ENV",
    group: "Core",
    label: "Node environment",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.nodeEnv,
  },
  {
    key: "core.sessionSecret",
    env: "CANVAS_DROP_SESSION_SECRET",
    group: "Core",
    label: "Session secret",
    type: "string",
    secret: true,
    editable: false,
    fromConfig: (c) => c.sessionSecret,
  },
  {
    key: "core.allowMultiUserPathMode",
    env: "CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE",
    group: "Core",
    label: "Allow multi-user path mode",
    type: "boolean",
    secret: false,
    editable: false,
    fromConfig: (c) => c.allowMultiUserPathMode,
  },

  // ── Realtime (Core capability toggle) ────────────────────────────────────
  // Read-only for now: the master switch gates the WS handshake (revoke-drops-
  // socket) — live-editing it is a deliberate follow-up.
  {
    key: "realtime.enabled",
    env: "CANVAS_DROP_REALTIME",
    group: "Core",
    label: "Realtime enabled",
    help: "Master switch for the realtime primitive (WebSocket pub/sub + presence).",
    type: "boolean",
    secret: false,
    editable: false,
    fromConfig: (c) => c.realtimeEnabled,
  },

  // ── Screenshots (preview pipeline, plan 004 / U12) ───────────────────────
  // Two layers: env AVAILABILITY (read-only) AND the admin runtime toggle (editable,
  // default off). Effective = available AND enabled (effectiveScreenshotsEnabled).
  // The editable toggle is the first editable boolean — it exercises the boolean
  // branch in setConfigOverride.
  {
    key: "screenshots.available",
    env: "CANVAS_DROP_SCREENSHOTS",
    group: "Core",
    label: "Screenshots available (env)",
    help: "Whether the environment provides screenshot capture (Chromium present / master enable). Set via env; the admin toggle below only takes effect when this is on.",
    type: "boolean",
    secret: false,
    editable: false,
    fromConfig: (c) => c.screenshots.available,
  },
  {
    key: "screenshots.enabled",
    env: "—",
    group: "Core",
    label: "Screenshots enabled",
    help: "Generate preview screenshots on publish (dashboard/gallery thumbnails + public OG). Off by default; only effective when 'Screenshots available (env)' is on. No per-user opt-out.",
    type: "boolean",
    secret: false,
    editable: true,
    settingKey: "config.screenshots.enabled",
    fromConfig: () => false,
  },

  // ── AI ──────────────────────────────────────────────────────────────────
  {
    key: "ai.apiKey",
    env: "CANVAS_DROP_AI_API_KEY",
    group: "AI",
    label: "Provider API key",
    help: "Server-side only. Used by the server to call the AI provider; never sent to the browser.",
    type: "string",
    secret: true,
    editable: true,
    settingKey: "config.ai.apiKey",
    fromConfig: (c) => c.ai.apiKey,
  },
  {
    key: "ai.models",
    env: "CANVAS_DROP_AI_MODELS",
    group: "AI",
    label: "Model allowlist",
    help: "Models canvases may call. Comma-separated plain IDs.",
    type: "csv",
    secret: false,
    editable: true,
    settingKey: "ai.models.allowlist",
    fromConfig: (c) => c.ai.models,
  },
  {
    key: "ai.provider",
    env: "CANVAS_DROP_AI_PROVIDER",
    group: "AI",
    label: "Provider",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.ai.provider,
  },
  {
    key: "ai.baseUrl",
    env: "CANVAS_DROP_AI_BASE_URL",
    group: "AI",
    label: "Provider base URL",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.ai.baseUrl,
  },

  // ── Email (guest invites) — read-only for now ────────────────────────────
  // Provider secrets are env-only (never DB-editable): invite emails are auth
  // credentials. Shown for transparency so an operator can confirm the transport.
  {
    key: "email.driver",
    env: "CANVAS_DROP_EMAIL_DRIVER",
    group: "Email",
    label: "Email driver",
    help: "How guest-invite magic links are sent: log (dev), smtp, mailgun, or noop.",
    type: "enum",
    enumValues: ["log", "smtp", "mailgun", "noop"],
    secret: false,
    editable: false,
    fromConfig: (c) => c.email.driver,
  },
  {
    key: "email.from",
    env: "CANVAS_DROP_EMAIL_FROM",
    group: "Email",
    label: "From address",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.email.from,
  },
  {
    key: "email.smtp.host",
    env: "CANVAS_DROP_SMTP_HOST",
    group: "Email",
    label: "SMTP host",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.email.smtp.host,
  },
  {
    key: "email.smtp.port",
    env: "CANVAS_DROP_SMTP_PORT",
    group: "Email",
    label: "SMTP port",
    type: "number",
    secret: false,
    editable: false,
    fromConfig: (c) => c.email.smtp.port,
  },
  {
    key: "email.smtp.user",
    env: "CANVAS_DROP_SMTP_USER",
    group: "Email",
    label: "SMTP user",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.email.smtp.user,
  },
  {
    key: "email.smtp.secure",
    env: "CANVAS_DROP_SMTP_SECURE",
    group: "Email",
    label: "SMTP implicit TLS",
    help: "true = port 465 implicit TLS; false = STARTTLS (port 587).",
    type: "boolean",
    secret: false,
    editable: false,
    fromConfig: (c) => c.email.smtp.secure,
  },
  {
    key: "email.smtp.pass",
    env: "CANVAS_DROP_SMTP_PASS",
    group: "Email",
    label: "SMTP password",
    type: "string",
    secret: true,
    editable: false,
    fromConfig: (c) => c.email.smtp.pass,
  },
  {
    key: "email.mailgun.domain",
    env: "CANVAS_DROP_MAILGUN_DOMAIN",
    group: "Email",
    label: "Mailgun domain",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.email.mailgun.domain,
  },
  {
    key: "email.mailgun.baseUrl",
    env: "CANVAS_DROP_MAILGUN_BASE_URL",
    group: "Email",
    label: "Mailgun base URL",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.email.mailgun.baseUrl,
  },
  {
    key: "email.mailgun.apiKey",
    env: "CANVAS_DROP_MAILGUN_API_KEY",
    group: "Email",
    label: "Mailgun API key",
    type: "string",
    secret: true,
    editable: false,
    fromConfig: (c) => c.email.mailgun.apiKey,
  },

  // ── Invite / notification emails (plan 003 phase 3; DB-only, no env) ──────
  {
    key: "email.invitesEnabled",
    env: "—",
    group: "Email",
    label: "Send invite & notification emails",
    help: "Master switch for invite + notification emails. Off by default; only effective when a real email driver is configured above. A brand-new invitee's onboarding email is the only way to reach them, so inviting a new person needs this on.",
    type: "boolean",
    secret: false,
    editable: true,
    settingKey: "config.email.invitesEnabled",
    fromConfig: () => false,
  },
  {
    key: "email.notifyOnAddUser",
    env: "—",
    group: "Email",
    label: "Notify on Add user",
    help: "Email an existing user when an admin adds their account.",
    type: "boolean",
    secret: false,
    editable: true,
    settingKey: "config.email.notifyOnAddUser",
    fromConfig: () => true,
  },
  {
    key: "email.notifyOnCanvasAdd",
    env: "—",
    group: "Email",
    label: "Notify on add to a canvas",
    help: "Email an existing user when they're added to a canvas's Specific-people list.",
    type: "boolean",
    secret: false,
    editable: true,
    settingKey: "config.email.notifyOnCanvasAdd",
    fromConfig: () => true,
  },
  {
    key: "email.notifyOnCanvasInvite",
    env: "—",
    group: "Email",
    label: "Notify on individual canvas invite",
    help: "Email an existing user on a deliberate one-off 'invite to this canvas' action.",
    type: "boolean",
    secret: false,
    editable: true,
    settingKey: "config.email.notifyOnCanvasInvite",
    fromConfig: () => true,
  },

  // ── Limits (quotas + rate limits) ────────────────────────────────────────
  {
    key: "invites.maxPerActorPerHour",
    env: "—",
    group: "Limits",
    label: "Invites per user per hour",
    help: "Max invites (and onboarding/notification emails) any one user may trigger per hour — bounds the self-serve invite abuse surface. Admins get a higher allowance.",
    type: "number",
    secret: false,
    editable: true,
    settingKey: "config.invites.maxPerActorPerHour",
    fromConfig: () => 20,
  },
  {
    key: "invites.pendingCap",
    env: "—",
    group: "Limits",
    label: "Outstanding invites per user",
    help: "Max not-yet-accepted invitations any one user may have outstanding — bounds standing blast radius even under the hourly rate.",
    type: "number",
    secret: false,
    editable: true,
    settingKey: "config.invites.pendingCap",
    fromConfig: () => 50,
  },
  {
    key: "invites.allowMemberNewEmails",
    env: "—",
    group: "Access",
    label: "Let members invite brand-new emails",
    help: "Off by default. When OFF, a member/guest invite only grants to people who can already sign in; permitting a brand-new external email is admin-only (Add users). When ON, any member may permit a new email to sign in by inviting them.",
    type: "boolean",
    secret: false,
    editable: true,
    settingKey: "config.invites.allowMemberNewEmails",
    fromConfig: () => false,
  },
  {
    key: "quota.ai.user.daily.usd",
    env: "CANVAS_DROP_AI_USER_DAILY_USD",
    group: "Limits",
    label: "AI per-user daily USD",
    type: "number",
    secret: false,
    editable: true,
    settingKey: "quota.ai.user.daily.usd",
    fromConfig: (c) => c.ai.userDailyUsd,
  },
  {
    key: "quota.ai.canvas.monthly.usd",
    env: "CANVAS_DROP_AI_CANVAS_MONTHLY_USD",
    group: "Limits",
    label: "AI per-canvas monthly USD",
    type: "number",
    secret: false,
    editable: true,
    settingKey: "quota.ai.canvas.monthly.usd",
    fromConfig: (c) => c.ai.canvasMonthlyUsd,
  },
  {
    key: "quota.kv.keys.shared",
    env: "—",
    group: "Limits",
    label: "KV shared keys per canvas",
    type: "number",
    secret: false,
    editable: true,
    settingKey: "quota.kv.keys.shared",
    fromConfig: () => KV_MAX_KEYS_SHARED,
  },
  {
    key: "quota.kv.keys.user",
    env: "—",
    group: "Limits",
    label: "KV per-user keys",
    type: "number",
    secret: false,
    editable: true,
    settingKey: "quota.kv.keys.user",
    fromConfig: () => KV_MAX_KEYS_USER,
  },
  {
    key: "quota.files.bytes.file",
    env: "—",
    group: "Limits",
    label: "Max file bytes",
    type: "number",
    secret: false,
    editable: true,
    settingKey: "quota.files.bytes.file",
    fromConfig: () => MAX_FILE_BYTES,
  },
  {
    key: "quota.files.bytes.canvas",
    env: "—",
    group: "Limits",
    label: "Max canvas bytes",
    type: "number",
    secret: false,
    editable: true,
    settingKey: "quota.files.bytes.canvas",
    fromConfig: () => MAX_CANVAS_BYTES,
  },
  // Rate limits are read-only for now: they're read on every request's hot path;
  // live-editing them is a deliberate follow-up.
  {
    key: "ratelimit.enabled",
    env: "CANVAS_DROP_RATELIMIT_ENABLED",
    group: "Limits",
    label: "Rate limiting enabled",
    type: "boolean",
    secret: false,
    editable: false,
    fromConfig: (c) => c.rateLimit.enabled,
  },
  {
    key: "ratelimit.canvasApiPerMin",
    env: "CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN",
    group: "Limits",
    label: "Rate: canvas API / min",
    type: "number",
    secret: false,
    editable: false,
    fromConfig: (c) => c.rateLimit.canvasApiPerMin,
  },
  {
    key: "ratelimit.aiPerMin",
    env: "CANVAS_DROP_RATELIMIT_AI_PER_MIN",
    group: "Limits",
    label: "Rate: AI / min",
    type: "number",
    secret: false,
    editable: false,
    fromConfig: (c) => c.rateLimit.aiPerMin,
  },
  {
    key: "ratelimit.deployPerMin",
    env: "CANVAS_DROP_RATELIMIT_DEPLOY_PER_MIN",
    group: "Limits",
    label: "Rate: deploy / min",
    type: "number",
    secret: false,
    editable: false,
    fromConfig: (c) => c.rateLimit.deployPerMin,
  },
  {
    key: "ratelimit.managementPerMin",
    env: "CANVAS_DROP_RATELIMIT_MANAGEMENT_PER_MIN",
    group: "Limits",
    label: "Rate: management / min",
    type: "number",
    secret: false,
    editable: false,
    fromConfig: (c) => c.rateLimit.managementPerMin,
  },
  {
    key: "ratelimit.loginPerMin",
    env: "CANVAS_DROP_RATELIMIT_LOGIN_PER_MIN",
    group: "Limits",
    label: "Rate: login / min",
    type: "number",
    secret: false,
    editable: false,
    fromConfig: (c) => c.rateLimit.loginPerMin,
  },
  {
    key: "ratelimit.passwordGatePerMin",
    env: "CANVAS_DROP_RATELIMIT_PASSWORD_GATE_PER_MIN",
    group: "Limits",
    label: "Rate: password gate / min",
    type: "number",
    secret: false,
    editable: false,
    fromConfig: (c) => c.rateLimit.passwordGatePerMin,
  },
  {
    key: "serving.publicEdgeCacheTtlSec",
    env: "CANVAS_DROP_PUBLIC_EDGE_CACHE_TTL",
    group: "Core",
    label: "Public edge-cache TTL (s)",
    help: "Seconds a CDN may cache a public canvas's HTML (s-maxage). Also the staleness window after an access downgrade. 0 disables shared caching.",
    type: "number",
    secret: false,
    editable: false,
    fromConfig: (c) => c.serving.publicEdgeCacheTtlSec,
  },

  // ── Access (who may sign in / who is admin) — read-only for now ───────────
  // §12 invariant surface (auth). Shown for transparency; live-editing is a
  // dedicated, security-reviewed follow-up.
  {
    key: "access.adminEmails",
    env: "CANVAS_DROP_ADMIN_EMAILS",
    group: "Access",
    label: "Admin emails",
    type: "csv",
    secret: false,
    editable: false,
    fromConfig: (c) => c.adminEmails,
  },
  {
    key: "access.allowedEmailDomains",
    env: "CANVAS_DROP_ALLOWED_EMAIL_DOMAINS",
    group: "Access",
    label: "Allowed email domains",
    type: "csv",
    secret: false,
    editable: false,
    fromConfig: (c) => c.auth.allowedEmailDomains,
  },

  // ── Auth (read-only) ─────────────────────────────────────────────────────
  {
    key: "auth.mode",
    env: "CANVAS_DROP_AUTH_MODE",
    group: "Auth",
    label: "Auth mode",
    type: "enum",
    enumValues: ["dev", "proxy", "oidc"],
    secret: false,
    editable: false,
    fromConfig: (c) => c.auth.mode,
  },
  {
    key: "auth.proxy.jwksUrl",
    env: "CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL",
    group: "Auth",
    label: "Proxy JWT JWKS URL",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.auth.proxy.jwksUrl,
  },
  {
    key: "auth.proxy.jwtIssuer",
    env: "CANVAS_DROP_AUTH_PROXY_JWT_ISSUER",
    group: "Auth",
    label: "Proxy JWT issuer",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.auth.proxy.jwtIssuer,
  },
  {
    key: "auth.proxy.jwtAudience",
    env: "CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE",
    group: "Auth",
    label: "Proxy JWT audience",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.auth.proxy.jwtAudience,
  },
  {
    key: "auth.proxy.emailHeader",
    env: "CANVAS_DROP_AUTH_PROXY_EMAIL_HEADER",
    group: "Auth",
    label: "Proxy email header",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.auth.proxy.emailHeader,
  },
  {
    key: "auth.proxy.trustedProxyIps",
    env: "CANVAS_DROP_TRUSTED_PROXY_IPS",
    group: "Auth",
    label: "Trusted proxy IPs",
    type: "csv",
    secret: false,
    editable: false,
    fromConfig: (c) => c.auth.proxy.trustedProxyIps,
  },
  {
    key: "auth.proxy.clientIpHeader",
    env: "CANVAS_DROP_CLIENT_IP_HEADER",
    group: "Auth",
    label: "CDN client-IP header",
    help: "Header carrying the real client IP behind a CDN (e.g. True-Client-IP). Trusted only from a trusted proxy IP.",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.auth.proxy.clientIpHeader,
  },
  {
    key: "auth.oidc.issuer",
    env: "CANVAS_DROP_OIDC_ISSUER",
    group: "Auth",
    label: "OIDC issuer",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.auth.oidc.issuer,
  },
  {
    key: "auth.oidc.clientId",
    env: "CANVAS_DROP_OIDC_CLIENT_ID",
    group: "Auth",
    label: "OIDC client id",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.auth.oidc.clientId,
  },
  {
    key: "auth.oidc.clientSecret",
    env: "CANVAS_DROP_OIDC_CLIENT_SECRET",
    group: "Auth",
    label: "OIDC client secret",
    type: "string",
    secret: true,
    editable: false,
    fromConfig: (c) => c.auth.oidc.clientSecret,
  },

  // ── Database (read-only) ─────────────────────────────────────────────────
  {
    key: "db.driver",
    env: "CANVAS_DROP_DB",
    group: "Database",
    label: "Driver",
    type: "enum",
    enumValues: ["sqlite", "postgres"],
    secret: false,
    editable: false,
    fromConfig: (c) => c.db.driver,
  },
  {
    key: "db.url",
    env: "CANVAS_DROP_DATABASE_URL",
    group: "Database",
    label: "Database URL",
    type: "string",
    secret: true,
    editable: false,
    fromConfig: (c) => (c.db.driver === "postgres" ? c.db.url : undefined),
  },
  {
    key: "db.sqlitePath",
    env: "CANVAS_DROP_SQLITE_PATH",
    group: "Database",
    label: "SQLite path",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => (c.db.driver === "sqlite" ? c.db.path : undefined),
  },

  // ── Storage (read-only) ──────────────────────────────────────────────────
  {
    key: "storage.driver",
    env: "CANVAS_DROP_STORAGE",
    group: "Storage",
    label: "Driver",
    type: "enum",
    enumValues: ["local", "s3"],
    secret: false,
    editable: false,
    fromConfig: (c) => c.storage.driver,
  },
  {
    key: "storage.path",
    env: "CANVAS_DROP_STORAGE_PATH",
    group: "Storage",
    label: "Local path",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => (c.storage.driver === "local" ? c.storage.path : undefined),
  },
  {
    key: "storage.s3.endpoint",
    env: "CANVAS_DROP_S3_ENDPOINT",
    group: "Storage",
    label: "S3 endpoint",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => (c.storage.driver === "s3" ? c.storage.endpoint : undefined),
  },
  {
    key: "storage.s3.bucket",
    env: "CANVAS_DROP_S3_BUCKET",
    group: "Storage",
    label: "S3 bucket",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => (c.storage.driver === "s3" ? c.storage.bucket : undefined),
  },
  {
    key: "storage.s3.region",
    env: "CANVAS_DROP_S3_REGION",
    group: "Storage",
    label: "S3 region",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => (c.storage.driver === "s3" ? c.storage.region : undefined),
  },
  {
    key: "storage.s3.accessKey",
    env: "CANVAS_DROP_S3_ACCESS_KEY",
    group: "Storage",
    label: "S3 access key",
    type: "string",
    secret: true,
    editable: false,
    fromConfig: (c) => (c.storage.driver === "s3" ? c.storage.accessKey : undefined),
  },
  {
    key: "storage.s3.secretKey",
    env: "CANVAS_DROP_S3_SECRET_KEY",
    group: "Storage",
    label: "S3 secret key",
    type: "string",
    secret: true,
    editable: false,
    fromConfig: (c) => (c.storage.driver === "s3" ? c.storage.secretKey : undefined),
  },

  // ── Logging / Observability (read-only) ──────────────────────────────────
  {
    key: "log.level",
    env: "LOG_LEVEL",
    group: "Logging",
    label: "Log level",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.log.level,
  },
  {
    key: "log.format",
    env: "LOG_FORMAT",
    group: "Logging",
    label: "Log format",
    type: "string",
    secret: false,
    editable: false,
    fromConfig: (c) => c.log.format,
  },
  {
    key: "observability.sentryDsn",
    env: "CANVAS_DROP_SENTRY_DSN",
    group: "Logging",
    label: "Sentry DSN",
    type: "string",
    secret: true,
    editable: false,
    fromConfig: (c) => c.sentryDsn,
  },
] as const;

export const CONFIG_FIELD_BY_KEY: ReadonlyMap<string, ConfigField> = new Map(
  CONFIG_FIELDS.map((f) => [f.key, f]),
);

/** Normalize a raw value to the canonical string used for last-4 / display. */
export function asDisplayString(type: ConfigType, value: unknown): string {
  if (value == null) return "";
  if (type === "csv") return csv(value).join(", ");
  if (type === "boolean") return value ? "true" : "false";
  return String(value);
}
