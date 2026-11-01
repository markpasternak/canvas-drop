import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURE_FALLBACK_VIEWPORT,
  CAPTURE_VIEWPORT,
  type CaptureContext,
  type CapturePage,
  type CaptureRoute,
  captureCanvas,
  encodeRenditions,
  FALLBACK_RESIZE_DEADLINE_MS,
  LAYOUT_PROBE_DEADLINE_MS,
  RENDITION_SIZES,
  SETTLE_DEADLINE_MS,
} from "./capture.js";
import { CAPTURE_TOKEN_HEADER } from "./capture-token.js";

/** A real PNG so the rendition pipeline runs through sharp. */
const masterPng = (): Promise<Buffer> =>
  sharp({ create: { width: 1200, height: 630, channels: 3, background: { r: 12, g: 34, b: 56 } } })
    .png()
    .toBuffer();

function fakePage(over: Partial<CapturePage> = {}): {
  page: CapturePage;
  routeHandler: () => (route: CaptureRoute) => unknown;
  headers: () => Record<string, string>;
  closed: () => boolean;
  viewports: () => Array<{ width: number; height: number }>;
} {
  let handler: (route: CaptureRoute) => unknown = () => {};
  let headers: Record<string, string> = {};
  let closed = false;
  const viewports: Array<{ width: number; height: number }> = [];
  const page: CapturePage = {
    async setExtraHTTPHeaders(h) {
      headers = h;
    },
    async route(_pattern, h) {
      handler = h;
    },
    on() {},
    async setViewportSize(size) {
      viewports.push(size);
    },
    async goto() {
      return null;
    },
    async evaluate<T>(fn: () => T | Promise<T>) {
      return fn();
    },
    async waitForTimeout() {},
    async screenshot() {
      return new Uint8Array(await masterPng());
    },
    async close() {
      closed = true;
    },
    ...over,
  };
  return {
    page,
    routeHandler: () => handler,
    headers: () => headers,
    closed: () => closed,
    viewports: () => viewports,
  };
}

const ctxFor = (page: CapturePage): CaptureContext => ({ newPage: async () => page });
const capture = (page: CapturePage) =>
  captureCanvas({
    context: ctxFor(page),
    url: "https://cv.example.test/",
    token: "tok",
    timeoutMs: 5000,
  });

function stubLayout(rootWidth = 900, bodyWidth = 900) {
  vi.stubGlobal("innerWidth", 900);
  vi.stubGlobal("document", {
    documentElement: { scrollWidth: rootWidth },
    body: { scrollWidth: bodyWidth },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const route = (
  url: string,
  method: string,
): { r: CaptureRoute; cont: () => boolean; abr: () => boolean } => {
  let cont = false;
  let abr = false;
  return {
    r: {
      request: () => ({ url: () => url, method: () => method }),
      continue: async () => {
        cont = true;
      },
      abort: async () => {
        abr = true;
      },
    },
    cont: () => cont,
    abr: () => abr,
  };
};

describe("RENDITION_SIZES (R2 contract)", () => {
  // Pin the literal dimensions so a regression trips here — the encodeRenditions test
  // reads the same constant, so it can't catch a wrong constant on its own. card/thumb
  // are 3:2 (must match the dashboard's aspect-[3/2] cover slots); og is the 1.91:1
  // link-unfurl standard.
  it("og is 1200×630; card and thumb are exactly 3:2", () => {
    expect(RENDITION_SIZES.og).toEqual({ width: 1200, height: 630 });
    expect(RENDITION_SIZES.card).toEqual({ width: 1200, height: 800 });
    expect(RENDITION_SIZES.thumb).toEqual({ width: 600, height: 400 });
  });
});

describe("encodeRenditions (U4)", () => {
  it("produces a valid WebP at each rendition's target size", async () => {
    const out = await encodeRenditions(new Uint8Array(await masterPng()));
    for (const r of ["og", "card", "thumb"] as const) {
      const meta = await sharp(out[r]).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(RENDITION_SIZES[r].width);
      expect(meta.height).toBe(RENDITION_SIZES[r].height);
    }
  });
});

describe("captureCanvas (U4)", () => {
  it.each([900, 901])(
    "keeps the compact desktop viewport when content width is %ipx",
    async (width) => {
      stubLayout(width, width);
      const f = fakePage();
      const screenshot = vi.spyOn(f.page, "screenshot");
      await capture(f.page);
      expect(CAPTURE_VIEWPORT).toEqual({ width: 900, height: 600 });
      expect(f.viewports()).toEqual([{ width: 900, height: 600 }]);
      expect(screenshot).toHaveBeenCalledExactlyOnceWith({
        type: "png",
        timeout: 5000,
        animations: "disabled",
      });
      expect(f.closed()).toBe(true);
    },
  );

  it.each([
    [902, 900],
    [900, 1440],
  ])("uses the original desktop viewport for root/body overflow (%i/%i)", async (root, body) => {
    stubLayout(root, body);
    const f = fakePage();
    const evaluate = vi.spyOn(f.page, "evaluate");
    const screenshot = vi.spyOn(f.page, "screenshot");
    await capture(f.page);
    expect(CAPTURE_FALLBACK_VIEWPORT).toEqual({ width: 1440, height: 960 });
    expect(f.viewports()).toEqual([CAPTURE_VIEWPORT, CAPTURE_FALLBACK_VIEWPORT]);
    expect(evaluate).toHaveBeenCalledTimes(3); // settle, probe, settle after resize
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.invocationCallOrder[2]).toBeLessThan(
      screenshot.mock.invocationCallOrder[0] as number,
    );
    expect(f.closed()).toBe(true);
  });

  it.each([
    undefined,
    { body: { scrollWidth: 900 } },
    { documentElement: { scrollWidth: 900 } },
    { documentElement: { scrollWidth: Number.NaN }, body: { scrollWidth: 900 } },
  ])("falls back when layout metrics are unavailable or invalid: %j", async (document) => {
    vi.stubGlobal("innerWidth", 900);
    vi.stubGlobal("document", document);
    const f = fakePage();
    await capture(f.page);
    expect(f.viewports()).toEqual([CAPTURE_VIEWPORT, CAPTURE_FALLBACK_VIEWPORT]);
    expect(f.closed()).toBe(true);
  });

  it("falls back when evaluating layout fails, then settles the resized page", async () => {
    const f = fakePage();
    const evaluate = vi
      .spyOn(f.page, "evaluate")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Execution context was destroyed"))
      .mockResolvedValueOnce(undefined);
    await capture(f.page);
    expect(f.viewports()).toEqual([CAPTURE_VIEWPORT, CAPTURE_FALLBACK_VIEWPORT]);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(f.closed()).toBe(true);
  });

  it("a hung layout probe falls back within its Node deadline and cannot change a later capture", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fakePage();
    let completeProbe: ((value: boolean) => void) | undefined;
    vi.spyOn(f.page, "evaluate")
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            completeProbe = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const screenshot = vi.spyOn(f.page, "screenshot");
    const done = capture(f.page);
    await vi.advanceTimersByTimeAsync(LAYOUT_PROBE_DEADLINE_MS - 1);
    expect(f.viewports()).toEqual([CAPTURE_VIEWPORT]);
    expect(screenshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.viewports()).toEqual([CAPTURE_VIEWPORT, CAPTURE_FALLBACK_VIEWPORT]);
    vi.useRealTimers();
    await done;
    completeProbe?.(true);
    await Promise.resolve();
    expect(f.viewports()).toEqual([CAPTURE_VIEWPORT, CAPTURE_FALLBACK_VIEWPORT]);
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(f.closed()).toBe(true);
  });

  it("sets the capture token header, captures, returns renditions, and closes the page", async () => {
    const f = fakePage();
    const out = await captureCanvas({
      context: ctxFor(f.page),
      url: "https://cv.example.test/",
      token: "tok-123",
      timeoutMs: 5000,
    });
    expect(f.headers()[CAPTURE_TOKEN_HEADER]).toBe("tok-123");
    expect(Object.keys(out).sort()).toEqual(["card", "og", "thumb"]);
    expect((await sharp(out.og).metadata()).format).toBe("webp");
    expect(f.closed()).toBe(true);
  });

  it("a hung fallback resize fails within its Node deadline and closes the page", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fakePage();
    const resize = vi
      .spyOn(f.page, "setViewportSize")
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise(() => {}));
    const evaluate = vi
      .spyOn(f.page, "evaluate")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(false);
    const screenshot = vi.spyOn(f.page, "screenshot");
    const failed = expect(capture(f.page)).rejects.toThrow(/fallback resize.*timed out/i);
    await vi.advanceTimersByTimeAsync(FALLBACK_RESIZE_DEADLINE_MS - 1);
    expect(f.closed()).toBe(false);
    expect(screenshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(resize).toHaveBeenNthCalledWith(2, CAPTURE_FALLBACK_VIEWPORT);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(screenshot).not.toHaveBeenCalled();
    expect(f.closed()).toBe(true);
  });

  it("hung initial/fallback settles and layout probe are each bounded before capture", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const f = fakePage({
        evaluate: () => new Promise(() => {}), // the page never lets the settle resolve
      });
      const done = captureCanvas({
        context: ctxFor(f.page),
        url: "https://cv.example.test/",
        token: "tok",
        timeoutMs: 5000,
      });
      await vi.advanceTimersByTimeAsync(SETTLE_DEADLINE_MS * 2 + LAYOUT_PROBE_DEADLINE_MS + 10);
      vi.useRealTimers();
      const out = await done;
      expect(Object.keys(out).sort()).toEqual(["card", "og", "thumb"]);
      expect(f.closed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("neuters the network: allows same-origin GETs, aborts everything else (R7)", async () => {
    const f = fakePage();
    await captureCanvas({
      context: ctxFor(f.page),
      url: "https://cv.example.test/",
      token: "t",
      timeoutMs: 5000,
    });
    const handler = f.routeHandler();

    const sameGet = route("https://cv.example.test/app.js", "GET"); // static asset
    const samePost = route("https://cv.example.test/v1/c/s/ai", "POST"); // AI primitive (write)
    const crossGet = route("https://evil.example/x", "GET"); // external fetch / SSRF
    const sameV1Get = route("https://cv.example.test/v1/c/s/kv/x", "GET"); // primitive READ
    // Prefix-superset host: shares `https://cv.example.test` as a string prefix but is a
    // DIFFERENT origin. A startsWith() gate would wrongly allow it (and leak the capture
    // token off-box); origin equality must abort it.
    const prefixHost = route("https://cv.example.test.attacker.com/leak", "GET");
    handler(sameGet.r);
    handler(samePost.r);
    handler(crossGet.r);
    handler(sameV1Get.r);
    handler(prefixHost.r);
    expect(sameGet.cont()).toBe(true);
    expect(sameGet.abr()).toBe(false);
    expect(samePost.abr()).toBe(true); // no AI spend
    expect(crossGet.abr()).toBe(true); // no outbound network
    expect(sameV1Get.abr()).toBe(true); // primitives neutered — even same-origin GET reads (review #5)
    expect(prefixHost.abr()).toBe(true); // prefix-superset host is a different origin → aborted
  });

  it("auto-dismisses dialogs (a dialog must not wedge the worker)", async () => {
    const dismiss = vi.fn().mockResolvedValue(undefined);
    let dialogHandler: ((d: { dismiss(): Promise<void> }) => unknown) | undefined;
    const f = fakePage({
      on(_e, h) {
        dialogHandler = h as typeof dialogHandler;
      },
    });
    await captureCanvas({
      context: ctxFor(f.page),
      url: "https://cv.example.test/",
      token: "t",
      timeoutMs: 5000,
    });
    dialogHandler?.({ dismiss });
    expect(dismiss).toHaveBeenCalled();
  });

  it("propagates a navigation timeout and still closes the page", async () => {
    const f = fakePage({
      async goto() {
        throw new Error("Timeout 5000ms exceeded");
      },
    });
    await expect(
      captureCanvas({
        context: ctxFor(f.page),
        url: "https://cv.example.test/",
        token: "t",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/timeout/i);
    expect(f.closed()).toBe(true);
  });

  it("propagates a screenshot timeout after fallback and still closes the page", async () => {
    const f = fakePage({
      async screenshot() {
        throw new Error("Screenshot timeout 5000ms exceeded");
      },
    });
    await expect(capture(f.page)).rejects.toThrow(/screenshot timeout/i);
    expect(f.viewports()).toEqual([CAPTURE_VIEWPORT, CAPTURE_FALLBACK_VIEWPORT]);
    expect(f.closed()).toBe(true);
  });
});
