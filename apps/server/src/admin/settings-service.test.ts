import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Json } from "@canvas-drop/shared/db";
import { describe, expect, it } from "vitest";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { adminSettingsService } from "./settings-service.js";

/** In-memory settings store — the service logic (fallback/override/validation) is
 *  dialect-independent, so a fake avoids spinning up a DB. */
function fakeSettings(): SettingsRepository {
  const store = new Map<string, Json>();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : undefined;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async keys() {
      return [...store.keys()];
    },
  };
}

const config = { ai: { models: ["claude-fast", "claude-smart"] } } as Config;

function svc() {
  return adminSettingsService({ settings: fakeSettings(), config });
}

describe("adminSettingsService", () => {
  it("effectiveModels falls back to config.ai.models, then honors an override (plain strings)", async () => {
    const s = svc();
    expect(await s.effectiveModels()).toEqual(["claude-fast", "claude-smart"]);
    expect(await s.getModelsOverride()).toBeNull();
    await s.setModels(["claude-opus", "claude-haiku"]);
    expect(await s.effectiveModels()).toEqual(["claude-opus", "claude-haiku"]);
    expect(await s.getModelsOverride()).toEqual(["claude-opus", "claude-haiku"]);
  });

  it("rejects an empty model allowlist (would disable AI by accident)", async () => {
    const s = svc();
    await expect(s.setModels([])).rejects.toThrow();
    expect(await s.getModelsOverride()).toBeNull(); // unchanged
  });

  it("effectiveQuota returns the caller fallback until an override is set", async () => {
    const s = svc();
    expect(await s.effectiveQuota("kv.keys.shared", 10_000)).toBe(10_000);
    await s.setQuota("kv.keys.shared", 5);
    expect(await s.effectiveQuota("kv.keys.shared", 10_000)).toBe(5);
    expect(await s.getQuotaOverride("kv.keys.shared")).toBe(5);
  });

  it("rejects a non-positive / non-finite quota (would poison enforcement)", async () => {
    const s = svc();
    await expect(s.setQuota("files.bytes.file", 0)).rejects.toThrow();
    await expect(s.setQuota("files.bytes.file", -1)).rejects.toThrow();
    await expect(s.setQuota("files.bytes.file", Number.NaN)).rejects.toThrow();
    expect(await s.getQuotaOverride("files.bytes.file")).toBeNull(); // unchanged
  });

  it("ignores a stored non-numeric/zero override and uses the fallback (defensive)", async () => {
    const settings = fakeSettings();
    await settings.set("quota.kv.keys.user", "garbage" as unknown as Json);
    const s = adminSettingsService({ settings, config });
    expect(await s.effectiveQuota("kv.keys.user", 1_000)).toBe(1_000);
  });
});

// Realistic config so describeConfig's per-field accessors don't hit undefined.
const ENV = {
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_AI_API_KEY: "sk-ant-env-key-WXYZ",
};
const fullConfig = loadConfig(ENV);
const envPresent = new Set(Object.keys(ENV));

function configSvc(extraEnv: Set<string> = envPresent) {
  return adminSettingsService({
    settings: fakeSettings(),
    config: fullConfig,
    envPresent: extraEnv,
  });
}

describe("adminSettingsService — AI provider key (write-only secret)", () => {
  it("effectiveApiKey/aiEnabled fall back to the env key, then a DB override wins", async () => {
    const s = configSvc();
    expect(await s.effectiveApiKey()).toBe("sk-ant-env-key-WXYZ");
    expect(await s.aiEnabled()).toBe(true);
    await s.setApiKey("sk-ant-db-override-1234");
    expect(await s.effectiveApiKey()).toBe("sk-ant-db-override-1234"); // DB overrides env
    await s.clearApiKey();
    expect(await s.effectiveApiKey()).toBe("sk-ant-env-key-WXYZ"); // back to env
  });

  it("getApiKeyStatus reports source + last4 but NEVER the raw key", async () => {
    const s = configSvc();
    const envStatus = await s.getApiKeyStatus();
    expect(envStatus).toEqual({ configured: true, source: "environment", last4: "WXYZ" });
    // No field anywhere equals the full key.
    expect(JSON.stringify(envStatus)).not.toContain("sk-ant-env-key-WXYZ");

    await s.setApiKey("sk-ant-db-override-1234");
    const dbStatus = await s.getApiKeyStatus();
    expect(dbStatus).toEqual({ configured: true, source: "database", last4: "1234" });
    expect(JSON.stringify(dbStatus)).not.toContain("sk-ant-db-override-1234");
  });

  it("with no env key and no DB key, AI is disabled until the admin sets one", async () => {
    const noKey = adminSettingsService({
      settings: fakeSettings(),
      config: loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" }),
      envPresent: new Set(["CANVAS_DROP_AUTH_MODE"]),
    });
    expect(await noKey.aiEnabled()).toBe(false);
    expect(await noKey.getApiKeyStatus()).toEqual({ configured: false, source: "default" });
    await noKey.setApiKey("sk-ant-fresh-0000");
    expect(await noKey.aiEnabled()).toBe(true);
  });

  it("setApiKey with empty/whitespace input clears the override (reverts to env)", async () => {
    const s = configSvc();
    await s.setApiKey("sk-ant-db-override-1234");
    await s.setApiKey("   ");
    expect(await s.effectiveApiKey()).toBe("sk-ant-env-key-WXYZ");
  });
});

describe("adminSettingsService — unified Configuration view", () => {
  it("describeConfig masks secrets (set + last4, no raw value) and labels the source", async () => {
    const s = configSvc();
    const rows = await s.describeConfig();
    const key = rows.find((r) => r.key === "ai.apiKey");
    expect(key).toMatchObject({ secret: true, editable: true, set: true, source: "environment" });
    expect(key?.last4).toBe("WXYZ");
    expect(key).not.toHaveProperty("value"); // raw value never serialized
    expect(JSON.stringify(rows)).not.toContain("sk-ant-env-key-WXYZ");
  });

  it("describeConfig shows non-secret values and flips source to database on override", async () => {
    const s = configSvc();
    let rows = await s.describeConfig();
    const models = rows.find((r) => r.key === "ai.models");
    // CANVAS_DROP_AI_MODELS isn't in our ENV set → the value comes from the default.
    expect(models).toMatchObject({ secret: false, editable: true, source: "default" });
    expect(models?.value).toContain("claude");

    await s.setConfigOverride("ai.models", ["claude-opus-4-8"]);
    rows = await s.describeConfig();
    const after = rows.find((r) => r.key === "ai.models");
    expect(after).toMatchObject({ source: "database", overridden: true, value: "claude-opus-4-8" });
  });

  it("a value not present in env shows source=default", async () => {
    // ai.models is NOT in our ENV set → default.
    const s = adminSettingsService({
      settings: fakeSettings(),
      config: fullConfig,
      envPresent: new Set(["CANVAS_DROP_AUTH_MODE"]),
    });
    const models = (await s.describeConfig()).find((r) => r.key === "ai.models");
    expect(models?.source).toBe("default");
  });
});

describe("adminSettingsService — setConfigOverride validation", () => {
  it("coerces + validates an editable number; rejects non-positive", async () => {
    const s = configSvc();
    await s.setConfigOverride("quota.ai.user.daily.usd", 25);
    expect(await s.effectiveQuota("ai.user.daily.usd", 5)).toBe(25);
    await expect(s.setConfigOverride("quota.ai.user.daily.usd", 0)).rejects.toThrow();
    await expect(s.setConfigOverride("quota.ai.user.daily.usd", -3)).rejects.toThrow();
  });

  it("rejects a read-only field and an unknown key", async () => {
    const s = configSvc();
    await expect(s.setConfigOverride("auth.mode", "oidc")).rejects.toThrow(/read-only/);
    await expect(s.setConfigOverride("access.adminEmails", "a@x.com")).rejects.toThrow(/read-only/);
    await expect(s.setConfigOverride("does.not.exist", "x")).rejects.toThrow(/unknown/);
  });

  it("empty csv / empty secret clears the override rather than storing nothing", async () => {
    const s = configSvc();
    await s.setConfigOverride("ai.models", ["a", "b"]);
    await s.setConfigOverride("ai.models", "   ,  "); // all-empty → clear
    const models = (await s.describeConfig()).find((r) => r.key === "ai.models");
    expect(models?.overridden).toBe(false);
  });

  it("clearConfigOverride reverts an editable field to env/default", async () => {
    const s = configSvc();
    await s.setApiKey("sk-ant-db-override-1234");
    await s.clearConfigOverride("ai.apiKey");
    expect(await s.effectiveApiKey()).toBe("sk-ant-env-key-WXYZ");
  });
});
