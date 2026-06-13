import type { Config } from "@canvas-drop/shared";
import { z } from "zod";
import type { SettingsRepository } from "../db/repositories/settings.js";

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
export function adminSettingsService(deps: { settings: SettingsRepository; config: Config }) {
  const { settings, config } = deps;

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
  };
}

export type AdminSettingsService = ReturnType<typeof adminSettingsService>;
/** The narrow resolver the primitives depend on (KV/files), injected optionally. */
export type QuotaResolver = (key: QuotaKey, fallback: number) => Promise<number>;
