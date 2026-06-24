import { describe, expect, it, vi } from "vitest";
import { launchChromiumWithChromeFallback } from "./playwright-browser.js";

type Launcher = Parameters<typeof launchChromiumWithChromeFallback>[0];

describe("launchChromiumWithChromeFallback", () => {
  it("uses the bundled Chromium launch first", async () => {
    const browser = { close: async () => {} };
    const launch = vi.fn().mockResolvedValue(browser);

    await expect(
      launchChromiumWithChromeFallback({ launch } as unknown as Launcher, {
        args: ["--flag"],
      }),
    ).resolves.toBe(browser);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith({ args: ["--flag"] });
  });

  it("falls back to the Chrome channel when the bundled browser is missing", async () => {
    const browser = { close: async () => {} };
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error("missing bundled chromium"))
      .mockResolvedValueOnce(browser);

    await expect(
      launchChromiumWithChromeFallback({ launch } as unknown as Launcher, {
        args: ["--flag"],
      }),
    ).resolves.toBe(browser);

    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenNthCalledWith(1, { args: ["--flag"] });
    expect(launch).toHaveBeenNthCalledWith(2, { args: ["--flag"], channel: "chrome" });
  });

  it("does not override an explicit browser channel", async () => {
    const launch = vi.fn().mockRejectedValue(new Error("explicit channel failed"));

    await expect(
      launchChromiumWithChromeFallback({ launch } as unknown as Launcher, {
        channel: "msedge",
      }),
    ).rejects.toThrow("explicit channel failed");

    expect(launch).toHaveBeenCalledTimes(1);
  });
});
