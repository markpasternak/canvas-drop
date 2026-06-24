import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../http/types.js";
import {
  assertCapability,
  CAPABILITY_DISABLED,
  capabilityDisabledDetail,
  requireCapability,
} from "./capability-guard.js";

const baseConfig: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

function canvas(overrides: Partial<Canvas> = {}): Canvas {
  return {
    id: "cv1",
    slug: "s",
    slugCustom: false,
    title: "",
    description: null,
    ownerId: "owner",
    orgId: null,
    access: "private",
    discoverability: "link_only",
    sharedExpiresAt: null,
    galleryListed: false,
    galleryTemplatable: false,
    tags: null,
    galleryFeatured: false,
    searchText: null,
    galleryPublishedAt: null,
    passwordHash: null,
    passwordVersion: 0,
    spaFallback: false,
    previewMode: "auto",
    backendEnabled: true,
    capKv: true,
    capFiles: true,
    capAi: true,
    capRealtime: true,
    guestAiEnabled: false,
    guestAiCap: 0,
    apiKeyHash: "h",
    status: "active",
    disabledReason: null,
    currentVersionId: "v1",
    clonedFromCanvasId: null,
    viewCount: 0,
    lastViewedAt: null,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...overrides,
  };
}

/** Build an app whose pre-middleware injects `cv` into context, then guards `/kv`. */
function guardedApp(
  cv: Canvas | null,
  config = baseConfig,
  cap: "kv" | "ai" | "realtime" | "identity" = "kv",
) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (cv) c.set("canvas", cv);
    c.set("log", { error() {} } as never);
    await next();
  });
  app.get("/g", requireCapability(cap, config), (c) => c.json({ ok: true }));
  return app;
}

describe("assertCapability", () => {
  it("true when backend + flag + global all on", () => {
    expect(assertCapability(canvas(), "kv", baseConfig)).toBe(true);
  });
  it("false when backend off", () => {
    expect(assertCapability(canvas({ backendEnabled: false }), "kv", baseConfig)).toBe(false);
  });
  it("false when the feature flag is off", () => {
    expect(assertCapability(canvas({ capKv: false }), "kv", baseConfig)).toBe(false);
  });
});

describe("requireCapability middleware", () => {
  it("passes when the capability is effective", async () => {
    const res = await guardedApp(canvas()).request("/g");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("403 CAPABILITY_DISABLED when backend is off — body carries a repair hint", async () => {
    const res = await guardedApp(canvas({ backendEnabled: false })).request("/g");
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    // `code` + `capability` stay stable; the reason/hint fields are additive (D7).
    expect(body).toMatchObject({
      code: CAPABILITY_DISABLED,
      capability: "kv",
      backendEnabled: false,
      reason: "backend_off",
    });
    expect(typeof body.hint).toBe("string");
    expect(body.hint as string).toMatch(/backend/i);
  });

  it("403 when the specific feature flag is off", async () => {
    const res = await guardedApp(canvas({ capKv: false })).request("/g");
    expect(res.status).toBe(403);
  });

  it("realtime: 403 when the operator global is off, even with backend + flag on", async () => {
    const realtimeOff = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev", CANVAS_DROP_REALTIME: "off" });
    const res = await guardedApp(canvas(), realtimeOff, "realtime").request("/g");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { capability: string }).capability).toBe("realtime");
  });

  it("ai: passes only when a provider key is configured", async () => {
    // default config has no provider → ai not effective
    expect((await guardedApp(canvas(), baseConfig, "ai").request("/g")).status).toBe(403);
    const aiOn = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev", CANVAS_DROP_AI_API_KEY: "sk-test" });
    expect((await guardedApp(canvas(), aiOn, "ai").request("/g")).status).toBe(200);
  });

  it("identity: passes with backend on, 403 with backend off", async () => {
    expect((await guardedApp(canvas(), baseConfig, "identity").request("/g")).status).toBe(200);
    expect(
      (await guardedApp(canvas({ backendEnabled: false }), baseConfig, "identity").request("/g"))
        .status,
    ).toBe(403);
  });

  it("500 contract error when no canvas was resolved upstream", async () => {
    const res = await guardedApp(null).request("/g");
    expect(res.status).toBe(500);
  });
});

describe("capabilityDisabledDetail", () => {
  it("backend off → reason backend_off, hint points at the master switch", () => {
    const d = capabilityDisabledDetail(canvas({ backendEnabled: false }), "kv");
    expect(d).toMatchObject({ capability: "kv", backendEnabled: false, reason: "backend_off" });
    expect(d.hint).toMatch(/backend/i);
  });

  it("backend on, feature flag off → reason feature_off, hint names the feature", () => {
    const d = capabilityDisabledDetail(canvas({ capFiles: false }), "files");
    expect(d).toMatchObject({ capability: "files", backendEnabled: true, reason: "feature_off" });
    expect(d.hint).toMatch(/"files"/);
  });

  it("backend + flag on but operator global off → reason operator_disabled (ai/realtime)", () => {
    // Reached only when the per-feature flag is on but the deployment global is off,
    // so the hint must not tell the owner to flip a canvas toggle they already have on.
    const ai = capabilityDisabledDetail(canvas(), "ai");
    expect(ai).toMatchObject({ backendEnabled: true, reason: "operator_disabled" });
    expect(ai.hint).toMatch(/deployment|provider key/i);
    const rt = capabilityDisabledDetail(canvas(), "realtime");
    expect(rt.reason).toBe("operator_disabled");
    expect(rt.hint).toMatch(/CANVAS_DROP_REALTIME/);
  });

  it("identity can only be backend_off (no feature flag, no global)", () => {
    expect(capabilityDisabledDetail(canvas({ backendEnabled: false }), "identity").reason).toBe(
      "backend_off",
    );
  });
});
