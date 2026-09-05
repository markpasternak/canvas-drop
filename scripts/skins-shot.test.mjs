import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSkinPanels } from "./skins-shot.mjs";

afterEach(() => vi.unstubAllGlobals());

function fixture({
  overridden = true,
  captureFails = false,
  restoreFails = false,
  readFails = false,
} = {}) {
  const writes = [];
  vi.stubGlobal("document", { fonts: { ready: Promise.resolve() } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      if (!options?.method) {
        return {
          ok: !readFails,
          status: readFails ? 503 : 200,
          json: async () => ({
            fields: [{ key: "core.designSkin", value: "editorial", overridden }],
          }),
        };
      }
      const { value } = JSON.parse(options.body);
      writes.push(value);
      const restoring = writes.length > 1 && value === (overridden ? "editorial" : "");
      return { ok: !(restoring && restoreFails), status: restoring && restoreFails ? 503 : 200 };
    }),
  );
  const page = {
    evaluate: async (fn, value) => fn(value),
    goto: vi.fn(),
    locator: () => ({ first: () => ({ waitFor: vi.fn() }) }),
    getByRole: () => ({ getAttribute: async () => "false" }),
    waitForTimeout: vi.fn(),
    screenshot: vi.fn(async () => {
      if (captureFails) throw new Error("Capture failed");
      return Buffer.from("image");
    }),
  };
  const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
  return { browser, writes };
}

describe("skin capture cleanup", () => {
  it("restores the saved override after both captures", async () => {
    const { browser, writes } = fixture();
    const panels = await captureSkinPanels(browser);
    expect(panels.map((p) => p.label)).toEqual(["Editorial", "Canvas"]);
    expect(writes).toEqual(["editorial", "canvas", "editorial"]);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("clears its temporary override when the original used the environment/default", async () => {
    const { browser, writes } = fixture({ overridden: false });
    await captureSkinPanels(browser);
    expect(writes).toEqual(["editorial", "canvas", ""]);
  });

  it("retains both the capture error and a failed restore", async () => {
    const { browser } = fixture({ captureFails: true, restoreFails: true });
    const error = await captureSkinPanels(browser).catch((e) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((e) => e.message)).toEqual([
      "Capture failed",
      "Could not restore the original skin; check Admin > Settings",
    ]);
    expect(error.errors[1].cause.message).toBe("Could not set skin: 503");
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("fails the command when only restoration fails", async () => {
    const { browser } = fixture({ restoreFails: true });
    await expect(captureSkinPanels(browser)).rejects.toThrow("Skin capture or cleanup failed");
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("closes the browser without changing settings after an unreadable original setting", async () => {
    const { browser, writes } = fixture({ readFails: true });
    await expect(captureSkinPanels(browser)).rejects.toThrow(AggregateError);
    expect(writes).toEqual([]);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("closes the browser even when creating the page fails", async () => {
    const { browser, writes } = fixture();
    browser.newPage.mockRejectedValue(new Error("Could not create page"));
    await expect(captureSkinPanels(browser)).rejects.toThrow(AggregateError);
    expect(writes).toEqual([]);
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
