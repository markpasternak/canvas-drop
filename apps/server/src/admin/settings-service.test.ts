import type { Config } from "@canvas-drop/shared";
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
