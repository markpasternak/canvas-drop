import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Json } from "@canvas-drop/shared/db";
import { describe, expect, it } from "vitest";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { adminSettingsService, type ConfigFieldView } from "./settings-service.js";

/** Narrow a view row to its secret arm (asserting it's present + secret). */
function asSecret(row: ConfigFieldView | undefined): Extract<ConfigFieldView, { secret: true }> {
  if (!row?.secret) throw new Error(`expected a secret config row, got: ${row?.key}`);
  return row;
}
/** Narrow a view row to its non-secret arm (asserting it's present + non-secret). */
function asPlain(row: ConfigFieldView | undefined): Extract<ConfigFieldView, { secret: false }> {
  if (!row || row.secret) throw new Error(`expected a non-secret config row, got: ${row?.key}`);
  return row;
}

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
  };
}

const config = { ai: { models: ["claude-fast", "claude-smart"] } } as Config;

function svc() {
  return adminSettingsService({ settings: fakeSettings(), config });
}

describe("adminSettingsService — effectiveDesignSkin (admin runtime flip)", () => {
  it("returns the env/default skin when no override is stored", async () => {
    const s = adminSettingsService({
      settings: fakeSettings(),
      config: loadConfig({ CANVAS_DROP_AUTH_MODE: "dev", CANVAS_DROP_DESIGN_SKIN: "canvas" }),
    });
    expect(await s.effectiveDesignSkin()).toBe("canvas");
  });

  it("lets a DB override win over env/default, and reverts when cleared", async () => {
    const s = adminSettingsService({
      settings: fakeSettings(),
      config: loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" }), // default editorial
    });
    expect(await s.effectiveDesignSkin()).toBe("editorial");
    await s.setConfigOverride("core.designSkin", "workshop");
    expect(await s.effectiveDesignSkin()).toBe("workshop");
    await s.clearConfigOverride("core.designSkin");
    expect(await s.effectiveDesignSkin()).toBe("editorial");
  });

  it("ignores a stored value that isn't a known skin (falls back to config)", async () => {
    const settings = fakeSettings();
    await settings.set("config.core.designSkin", "neon-from-a-removed-skin");
    const s = adminSettingsService({
      settings,
      config: loadConfig({ CANVAS_DROP_AUTH_MODE: "dev", CANVAS_DROP_DESIGN_SKIN: "studio" }),
    });
    expect(await s.effectiveDesignSkin()).toBe("studio");
  });
});

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

// The provider key is written/read via setConfigOverride/describeConfig ("ai.apiKey")
// like every other setting — there is no bespoke key API.
const aiKeyRow = async (s: ReturnType<typeof configSvc>) =>
  (await s.describeConfig()).find((r) => r.key === "ai.apiKey");

describe("adminSettingsService — AI provider key (write-only secret)", () => {
  it("effectiveApiKey/aiEnabled fall back to the env key, then a DB override wins", async () => {
    const s = configSvc();
    expect(await s.effectiveApiKey()).toBe("sk-ant-env-key-WXYZ");
    expect(await s.aiEnabled()).toBe(true);
    await s.setConfigOverride("ai.apiKey", "sk-ant-db-override-1234");
    expect(await s.effectiveApiKey()).toBe("sk-ant-db-override-1234"); // DB overrides env
    await s.clearConfigOverride("ai.apiKey");
    expect(await s.effectiveApiKey()).toBe("sk-ant-env-key-WXYZ"); // back to env
  });

  it("the config view reports source + last4 but NEVER the raw key", async () => {
    const s = configSvc();
    const env = await aiKeyRow(s);
    expect(env).toMatchObject({ set: true, source: "environment", last4: "WXYZ" });
    expect(env).not.toHaveProperty("value");
    expect(JSON.stringify(env)).not.toContain("sk-ant-env-key-WXYZ");

    await s.setConfigOverride("ai.apiKey", "sk-ant-db-override-1234");
    const db = await aiKeyRow(s);
    expect(db).toMatchObject({ set: true, source: "database", last4: "1234" });
    expect(JSON.stringify(db)).not.toContain("sk-ant-db-override-1234");
  });

  it("with no env key and no DB key, AI is disabled until the admin sets one", async () => {
    const noKey = adminSettingsService({
      settings: fakeSettings(),
      config: loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" }),
      envPresent: new Set(["CANVAS_DROP_AUTH_MODE"]),
    });
    expect(await noKey.aiEnabled()).toBe(false);
    expect(asSecret(await aiKeyRow(noKey)).set).toBe(false);
    await noKey.setConfigOverride("ai.apiKey", "sk-ant-fresh-0000");
    expect(await noKey.aiEnabled()).toBe(true);
  });

  it("empty/whitespace input clears the key override (reverts to env)", async () => {
    const s = configSvc();
    await s.setConfigOverride("ai.apiKey", "sk-ant-db-override-1234");
    await s.setConfigOverride("ai.apiKey", "   ");
    expect(await s.effectiveApiKey()).toBe("sk-ant-env-key-WXYZ");
  });

  it("a READ-ONLY secret exposes only `set` — never last4 (no fragment leak)", async () => {
    // Session secret is secret + read-only → set:true, but NO last4.
    const s = configSvc();
    const sessionSecret = asSecret(
      (await s.describeConfig()).find((r) => r.key === "core.sessionSecret"),
    );
    expect(sessionSecret).toMatchObject({ secret: true, editable: false, set: true });
    expect(sessionSecret.last4).toBeUndefined();
    expect(sessionSecret).not.toHaveProperty("value");
  });
});

describe("adminSettingsService — unified Configuration view", () => {
  it("describeConfig masks secrets (set + last4, no raw value) and labels the source", async () => {
    const s = configSvc();
    const rows = await s.describeConfig();
    const key = asSecret(rows.find((r) => r.key === "ai.apiKey"));
    expect(key).toMatchObject({ secret: true, editable: true, set: true, source: "environment" });
    expect(key.last4).toBe("WXYZ");
    expect(key).not.toHaveProperty("value"); // raw value never serialized
    expect(JSON.stringify(rows)).not.toContain("sk-ant-env-key-WXYZ");
  });

  it("describeConfig shows non-secret values and flips source to database on override", async () => {
    const s = configSvc();
    let rows = await s.describeConfig();
    const models = asPlain(rows.find((r) => r.key === "ai.models"));
    // CANVAS_DROP_AI_MODELS isn't in our ENV set → the value comes from the default.
    expect(models).toMatchObject({ secret: false, editable: true, source: "default" });
    expect(models.value).toContain("claude");

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
    await s.setConfigOverride("ai.apiKey", "sk-ant-db-override-1234");
    await s.clearConfigOverride("ai.apiKey");
    expect(await s.effectiveApiKey()).toBe("sk-ant-env-key-WXYZ");
  });
});

describe("adminSettingsService — screenshots enablement (plan 004 / U12)", () => {
  const cfg = (available: boolean) => ({ screenshots: { available } }) as Config;

  it("effective state = env-available AND admin-enabled (truth table)", async () => {
    // env OFF → always false, even if the admin toggle is set on
    const envOff = adminSettingsService({ settings: fakeSettings(), config: cfg(false) });
    expect(await envOff.effectiveScreenshotsEnabled()).toBe(false);
    await envOff.setConfigOverride("screenshots.enabled", true);
    expect(await envOff.effectiveScreenshotsEnabled()).toBe(false); // env availability wins

    // env ON + admin unset → false (default off)
    const envOn = adminSettingsService({ settings: fakeSettings(), config: cfg(true) });
    expect(await envOn.effectiveScreenshotsEnabled()).toBe(false);

    // env ON + admin true → true (first editable boolean — exercises setConfigOverride's boolean branch)
    await envOn.setConfigOverride("screenshots.enabled", true);
    expect(await envOn.effectiveScreenshotsEnabled()).toBe(true);

    // env ON + admin explicitly false → false
    await envOn.setConfigOverride("screenshots.enabled", false);
    expect(await envOn.effectiveScreenshotsEnabled()).toBe(false);

    // clearing the override reverts to default off
    await envOn.setConfigOverride("screenshots.enabled", true);
    await envOn.clearConfigOverride("screenshots.enabled");
    expect(await envOn.effectiveScreenshotsEnabled()).toBe(false);
  });

  it("exposes the admin toggle as editable and the env availability as read-only", async () => {
    const rows = await configSvc().describeConfig();
    const toggle = rows.find((r) => r.key === "screenshots.enabled");
    const avail = rows.find((r) => r.key === "screenshots.available");
    expect(toggle).toMatchObject({ editable: true, type: "boolean" });
    expect(avail).toMatchObject({ editable: false, type: "boolean" });
  });
});

describe("adminSettingsService — public links gate", () => {
  it("defaults public links on and honors an admin override", async () => {
    const s = configSvc();
    expect(await s.effectivePublicLinksEnabled()).toBe(true);
    await s.setConfigOverride("access.publicLinksEnabled", false);
    expect(await s.effectivePublicLinksEnabled()).toBe(false);
    await s.clearConfigOverride("access.publicLinksEnabled");
    expect(await s.effectivePublicLinksEnabled()).toBe(true);
  });

  it("exposes the public links switch as an editable Access boolean", async () => {
    const row = (await configSvc().describeConfig()).find(
      (r) => r.key === "access.publicLinksEnabled",
    );
    expect(row).toMatchObject({
      group: "Access",
      editable: true,
      type: "boolean",
      value: "true",
      source: "default",
    });
  });
});

describe("effectiveInviteSettings (plan 003 phase 3)", () => {
  it("defaults: email off, notifications on, rate 20/h, pending cap 50, member-new-emails off", async () => {
    const s = adminSettingsService({ settings: fakeSettings(), config });
    expect(await s.effectiveInviteSettings()).toEqual({
      emailEnabled: false,
      notifyOnAddUser: true,
      notifyOnCanvasAdd: true,
      notifyOnCanvasInvite: true,
      maxPerActorPerHour: 20,
      pendingCap: 50,
      allowMemberNewEmails: false,
    });
  });

  it("DB overrides win (email on, tighter rate, member-new-emails on)", async () => {
    const store = fakeSettings();
    await store.set("config.email.invitesEnabled", true);
    await store.set("config.invites.maxPerActorPerHour", 5);
    await store.set("config.invites.pendingCap", 3);
    await store.set("config.invites.allowMemberNewEmails", true);
    await store.set("config.email.notifyOnCanvasAdd", false);
    const eff = await adminSettingsService({ settings: store, config }).effectiveInviteSettings();
    expect(eff).toMatchObject({
      emailEnabled: true,
      maxPerActorPerHour: 5,
      pendingCap: 3,
      allowMemberNewEmails: true,
      notifyOnCanvasAdd: false,
    });
  });

  it("a non-positive rate override falls back to the default", async () => {
    const store = fakeSettings();
    await store.set("config.invites.maxPerActorPerHour", 0);
    const s = adminSettingsService({ settings: store, config });
    expect((await s.effectiveInviteSettings()).maxPerActorPerHour).toBe(20);
  });
});
