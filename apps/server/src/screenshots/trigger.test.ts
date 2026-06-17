import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { screenshotTrigger } from "./trigger.js";

const silent = pino({ level: "silent" });
const CANVAS_ID = "0190a000-0000-7000-8000-000000000001";
const VERSION = "0190b000-0000-7000-8000-0000000000a1";
const CANVAS = { id: CANVAS_ID, previewMode: "auto" };

describe("screenshotTrigger (plan 004 / U12)", () => {
  it("enqueues when effective-enabled", async () => {
    const calls: Array<[string, string]> = [];
    const t = screenshotTrigger({
      enabled: async () => true,
      repo: { enqueue: async (c, v) => void calls.push([c, v]) },
      log: silent,
    });
    await t.enqueue(CANVAS, VERSION);
    expect(calls).toEqual([[CANVAS_ID, VERSION]]);
  });

  it("skips canvases whose previewMode is not 'auto' (custom/off opt-out)", async () => {
    const calls: Array<[string, string]> = [];
    const t = screenshotTrigger({
      enabled: async () => true,
      repo: { enqueue: async (c, v) => void calls.push([c, v]) },
      log: silent,
    });
    await t.enqueue({ id: CANVAS_ID, previewMode: "custom" }, VERSION);
    await t.enqueue({ id: CANVAS_ID, previewMode: "off" }, VERSION);
    expect(calls).toEqual([]);
  });

  it("is a no-op when disabled (the gate that protects the admin off switch)", async () => {
    const calls: Array<[string, string]> = [];
    const t = screenshotTrigger({
      enabled: async () => false,
      repo: { enqueue: async (c, v) => void calls.push([c, v]) },
      log: silent,
    });
    await t.enqueue(CANVAS, VERSION);
    expect(calls).toEqual([]);
  });

  it("never throws when the enqueue fails (best-effort)", async () => {
    const t = screenshotTrigger({
      enabled: async () => true,
      repo: {
        enqueue: async () => {
          throw new Error("db down");
        },
      },
      log: silent,
    });
    await expect(t.enqueue(CANVAS, VERSION)).resolves.toBeUndefined();
  });

  it("never throws when the enablement check itself fails", async () => {
    const t = screenshotTrigger({
      enabled: async () => {
        throw new Error("settings down");
      },
      repo: { enqueue: async () => {} },
      log: silent,
    });
    await expect(t.enqueue(CANVAS, VERSION)).resolves.toBeUndefined();
  });
});
