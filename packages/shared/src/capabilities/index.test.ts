import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  type CanvasCapabilityState,
  effectiveCapabilities,
  FEATURE_CAPABILITIES,
  FEATURE_COLUMN,
  isCapabilityEnabled,
  storedCapabilities,
} from "./index.js";

const ALL_ON: CanvasCapabilityState = {
  backendEnabled: true,
  capKv: true,
  capFiles: true,
  capAi: true,
  capRealtime: true,
};

const GLOBALS_ON = { realtimeEnabled: true, aiEnabled: true };

describe("effectiveCapabilities", () => {
  it("backend off → every capability (incl. identity) is off regardless of flags", () => {
    const eff = effectiveCapabilities({ ...ALL_ON, backendEnabled: false }, GLOBALS_ON);
    for (const cap of CAPABILITIES) expect(eff[cap]).toBe(false);
  });

  it("backend on + all flags + all globals → everything on", () => {
    const eff = effectiveCapabilities(ALL_ON, GLOBALS_ON);
    for (const cap of CAPABILITIES) expect(eff[cap]).toBe(true);
  });

  it("a feature flag off disables only that feature", () => {
    const eff = effectiveCapabilities({ ...ALL_ON, capAi: false }, GLOBALS_ON);
    expect(eff.ai).toBe(false);
    expect(eff.kv).toBe(true);
    expect(eff.files).toBe(true);
    expect(eff.realtime).toBe(true);
    expect(eff.identity).toBe(true);
  });

  it("realtime ANDs the operator global flag", () => {
    const eff = effectiveCapabilities(ALL_ON, { realtimeEnabled: false, aiEnabled: true });
    expect(eff.realtime).toBe(false);
    expect(eff.kv).toBe(true); // unaffected by the realtime global
  });

  it("ai ANDs the operator provider flag", () => {
    const eff = effectiveCapabilities(ALL_ON, { realtimeEnabled: true, aiEnabled: false });
    expect(eff.ai).toBe(false);
    expect(eff.realtime).toBe(true);
  });

  it("kv/files have no global switch — on whenever backend + flag are on", () => {
    const eff = effectiveCapabilities(ALL_ON, { realtimeEnabled: false, aiEnabled: false });
    expect(eff.kv).toBe(true);
    expect(eff.files).toBe(true);
  });

  it("identity is on with backend even when every feature flag is off", () => {
    const eff = effectiveCapabilities(
      { backendEnabled: true, capKv: false, capFiles: false, capAi: false, capRealtime: false },
      GLOBALS_ON,
    );
    expect(eff.identity).toBe(true);
    expect(eff.kv).toBe(false);
  });
});

describe("isCapabilityEnabled", () => {
  it("matches effectiveCapabilities for a single key", () => {
    expect(isCapabilityEnabled(ALL_ON, "kv", GLOBALS_ON)).toBe(true);
    expect(isCapabilityEnabled({ ...ALL_ON, capKv: false }, "kv", GLOBALS_ON)).toBe(false);
    expect(isCapabilityEnabled({ ...ALL_ON, backendEnabled: false }, "identity", GLOBALS_ON)).toBe(
      false,
    );
  });
});

describe("storedCapabilities", () => {
  it("returns the raw flags independent of backend/global state", () => {
    const stored = storedCapabilities({ ...ALL_ON, backendEnabled: false, capAi: false });
    expect(stored).toEqual({ kv: true, files: true, ai: false, realtime: true });
  });
});

describe("taxonomy", () => {
  it("the four feature capabilities are exactly kv/files/ai/realtime", () => {
    expect([...FEATURE_CAPABILITIES]).toEqual(["kv", "files", "ai", "realtime"]);
  });

  it("every feature capability maps to a real canvas column", () => {
    for (const cap of FEATURE_CAPABILITIES) {
      expect(FEATURE_COLUMN[cap]).toMatch(/^cap[A-Z]/);
    }
  });
});
