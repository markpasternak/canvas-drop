import type { Config } from "@canvas-drop/shared";
import { z } from "zod";
import type { SettingsRepository } from "../db/repositories/settings.js";
import {
  asDisplayString,
  CONFIG_FIELD_BY_KEY,
  CONFIG_FIELDS,
  type ConfigField,
  type ConfigGroup,
} from "./config-fields.js";

/** AI provider-key override store key (write-only secret; DB overrides env). */
const AI_API_KEY = "config.ai.apiKey";
/** Realtime master-switch override key (read-only in the registry today). */
const REALTIME_KEY = "config.realtime.enabled";

const last4 = (s: string) => (s.length <= 4 ? s : s.slice(-4));

/** Source of a setting's effective value, for the admin Configuration view. */
export type ConfigSource = "database" | "environment" | "default";

/** One row in the admin Configuration view. Secrets carry NO raw value. */
export interface ConfigFieldView {
  key: string;
  env: string;
  group: ConfigGroup;
  label: string;
  help?: string;
  type: ConfigField["type"];
  enumValues?: readonly string[];
  secret: boolean;
  editable: boolean;
  source: ConfigSource;
  /** Whether a DB override is currently set (editable fields). */
  overridden: boolean;
  /** Non-secret effective value (display form). Omitted for secrets. */
  value?: string;
  /** Secret-only: is a value configured, and its last 4 chars. Never the value. */
  set?: boolean;
  last4?: string;
}

/**
 * Admin-tunable global quota keys (§6.10.4, §12.3). Stored in the `settings`
 * table under `quota.<key>`. The hard fallback constant for each is owned by the
 * primitive that enforces it (KV/files) and passed to {@link effectiveQuota} by
 * the caller — so the resolver stays generic and there's no import cycle between
 * this service and the primitive routes. AI quotas fall back to `config.ai.*`.
 */
export type QuotaKey =
  | "kv.keys.shared"
  | "kv.keys.user"
  | "files.bytes.file"
  | "files.bytes.canvas"
  | "ai.user.daily.usd"
  | "ai.canvas.monthly.usd";

export const QUOTA_KEYS: readonly QuotaKey[] = [
  "kv.keys.shared",
  "kv.keys.user",
  "files.bytes.file",
  "files.bytes.canvas",
  "ai.user.daily.usd",
  "ai.canvas.monthly.usd",
];

const MODELS_KEY = "ai.models.allowlist";
const quotaSettingKey = (key: QuotaKey) => `quota.${key}`;

/** Positive, finite number — a non-positive/NaN quota would poison enforcement. */
const quotaValue = z.number().finite().positive();
/** Non-empty list of non-empty model-ID strings (plain IDs; no provider prefix — D12). */
const modelsValue = z.array(z.string().min(1)).min(1);

/**
 * Admin settings service (§6.10.3/4, M7). Typed get/set over the `settings`
 * key/JSON store for the AI model allowlist and the global quota defaults, plus a
 * resolver the primitives read.
 *
 * **No in-process cache** (M7 scope review): `effectiveQuota` is a plain
 * per-request read — a primary-key lookup on a tiny table, correct and cheap at
 * the trusted-org single-process scale (§9.7). A cache (with its stale-window +
 * invalidation logic) is premature; add it only if instrumentation shows the read
 * matters. Per-canvas/per-user overrides are v1.1 (§6.10.7) — this ships globals.
 */
export function adminSettingsService(deps: {
  settings: SettingsRepository;
  config: Config;
  /** Which config env vars were explicitly set — for source attribution (§8.1). */
  envPresent?: Set<string>;
}) {
  const { settings, config } = deps;
  const envPresent = deps.envPresent ?? new Set<string>();

  /** A stored string override (trimmed, non-empty), else undefined. */
  async function strOverride(key: string): Promise<string | undefined> {
    const v = await settings.get(key);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  }
  /** A stored boolean override, else undefined. */
  async function boolOverride(key: string): Promise<boolean | undefined> {
    const v = await settings.get(key);
    return typeof v === "boolean" ? v : undefined;
  }

  return {
    /**
     * Effective quota = the admin override (if a valid number is stored) else the
     * caller's `fallback`. The caller owns the fallback (its hard constant or a
     * `config.ai.*` default), so this resolver imports no primitive constants.
     */
    async effectiveQuota(key: QuotaKey, fallback: number): Promise<number> {
      const v = await settings.get(quotaSettingKey(key));
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
    },

    /** The raw stored override for a quota key, or null when using the default. */
    async getQuotaOverride(key: QuotaKey): Promise<number | null> {
      const v = await settings.get(quotaSettingKey(key));
      return typeof v === "number" ? v : null;
    },

    /** Validate + persist a global quota default. Throws on a non-positive value. */
    async setQuota(key: QuotaKey, value: number): Promise<void> {
      const parsed = quotaValue.safeParse(value);
      if (!parsed.success) throw new Error(`invalid quota value for ${key}: must be > 0`);
      await settings.set(quotaSettingKey(key), parsed.data);
    },

    /**
     * Effective AI model allowlist (§6.10.3). The admin override (a non-empty
     * string[]) wins; otherwise the env default `config.ai.models`. Returns plain
     * model-ID strings (no provider prefix — D12; the U3↔M9 contract).
     */
    async effectiveModels(): Promise<string[]> {
      const v = await settings.get(MODELS_KEY);
      const parsed = modelsValue.safeParse(v);
      return parsed.success ? parsed.data : config.ai.models;
    },

    /** The raw stored allowlist override, or null when using the config default. */
    async getModelsOverride(): Promise<string[] | null> {
      const v = await settings.get(MODELS_KEY);
      const parsed = modelsValue.safeParse(v);
      return parsed.success ? parsed.data : null;
    },

    /** Validate + persist the model allowlist. Throws on an empty/invalid list. */
    async setModels(models: string[]): Promise<void> {
      const parsed = modelsValue.safeParse(models);
      if (!parsed.success) throw new Error("invalid model allowlist: must be a non-empty list");
      await settings.set(MODELS_KEY, parsed.data);
    },

    // ── AI provider key (write-only secret; DB overrides env) ────────────────

    /**
     * Effective AI provider key: the admin-set DB value wins, else the env key
     * (`config.ai.apiKey`, already empty→undefined). Server-side ONLY — never
     * serialize this anywhere a browser can read it.
     */
    async effectiveApiKey(): Promise<string | undefined> {
      return (await strOverride(AI_API_KEY)) ?? config.ai.apiKey;
    },

    /** Whether AI is usable (an effective key exists). Drives the capability gate. */
    async aiEnabled(): Promise<boolean> {
      return !!(await this.effectiveApiKey());
    },

    // The provider key is read (write) via describeConfig / setConfigOverride
    // ("ai.apiKey") like every other setting — there is no bespoke key endpoint.

    // ── Other effective getters the hot-path consumers read ──────────────────

    /**
     * Effective realtime master switch (DB override ?? env). Read by the
     * management capability view. (The override is read-only in the registry for
     * now, so this currently tracks the env value; the resolver is here so the
     * editable follow-up is a one-line registry flip.)
     */
    async effectiveRealtimeEnabled(): Promise<boolean> {
      return (await boolOverride(REALTIME_KEY)) ?? config.realtimeEnabled;
    },

    // ── Unified Configuration view (all settings; one resolution rule) ───────

    /** Every setting as a view row: value/source/secret-mask. Grouped by the caller. */
    async describeConfig(): Promise<ConfigFieldView[]> {
      return Promise.all(
        CONFIG_FIELDS.map(async (f): Promise<ConfigFieldView> => {
          const override =
            f.editable && f.settingKey ? await settings.get(f.settingKey) : undefined;
          const overridden = override !== undefined && override !== null;
          const effective = overridden ? override : f.fromConfig(config);
          const source: ConfigSource = overridden
            ? "database"
            : envPresent.has(f.env)
              ? "environment"
              : "default";
          const base = {
            key: f.key,
            env: f.env,
            group: f.group,
            label: f.label,
            help: f.help,
            type: f.type,
            enumValues: f.enumValues,
            secret: f.secret,
            editable: f.editable,
            source,
            overridden,
          };
          if (f.secret) {
            const s = effective == null ? "" : String(effective);
            // last4 only for EDITABLE secrets (the AI key) — a confirmation aid for
            // a key you can set here. Read-only env secrets (session secret, DB URL,
            // OIDC/S3 secrets) expose nothing but "configured" — no fragment leaks.
            const showLast4 = f.editable && s !== "";
            return { ...base, set: s !== "", last4: showLast4 ? last4(s) : undefined };
          }
          return { ...base, value: asDisplayString(f.type, effective) };
        }),
      );
    },

    /**
     * Set a DB override for an editable field, validating + coercing the raw input
     * to the field's type. Empty string / empty list CLEARS the override (reverts to
     * env/default) rather than storing a dangerous empty value. Throws on an unknown
     * key, a read-only field, or an invalid value.
     */
    async setConfigOverride(key: string, raw: unknown): Promise<void> {
      const f = CONFIG_FIELD_BY_KEY.get(key);
      if (!f) throw new Error(`unknown setting: ${key}`);
      if (!f.editable || !f.settingKey) throw new Error(`setting is read-only: ${key}`);
      const sk = f.settingKey;

      switch (f.type) {
        case "number": {
          // Accept a number or a numeric string; reject arrays/booleans/objects so a
          // wrong-typed body (e.g. [5] or true) is a 400, not a silently coerced value.
          if (typeof raw !== "number" && typeof raw !== "string") {
            throw new Error(`${key} must be a number`);
          }
          const n = Number(raw);
          if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a number > 0`);
          await settings.set(sk, n);
          return;
        }
        // boolean/enum: forward-compat scaffolding. No editable field is boolean or
        // enum today (realtime/rate-limit/auth-mode are read-only), so these branches
        // are unreached until the editable set grows; kept so that's a one-line flip.
        case "boolean": {
          const b = typeof raw === "boolean" ? raw : raw === "true";
          await settings.set(sk, b);
          return;
        }
        case "csv": {
          const list = (
            Array.isArray(raw) ? (raw as unknown[]).map(String) : String(raw).split(",")
          )
            .map((s) => s.trim())
            .filter((s) => s !== "");
          if (list.length === 0) {
            await settings.delete(sk); // empty → clear rather than store an empty list
            return;
          }
          await settings.set(sk, list);
          return;
        }
        default: {
          // string / enum / secret string
          const s = String(raw).trim();
          if (f.enumValues && s !== "" && !f.enumValues.includes(s)) {
            throw new Error(`${key} must be one of: ${f.enumValues.join(", ")}`);
          }
          if (s === "") await settings.delete(sk);
          else await settings.set(sk, s);
          return;
        }
      }
    },

    /** Clear a DB override so the field reverts to its env/default value. */
    async clearConfigOverride(key: string): Promise<void> {
      const f = CONFIG_FIELD_BY_KEY.get(key);
      if (!f || !f.editable || !f.settingKey) throw new Error(`cannot clear: ${key}`);
      await settings.delete(f.settingKey);
    },
  };
}

export type AdminSettingsService = ReturnType<typeof adminSettingsService>;
/** The narrow resolver the primitives depend on (KV/files), injected optionally. */
export type QuotaResolver = (key: QuotaKey, fallback: number) => Promise<number>;
