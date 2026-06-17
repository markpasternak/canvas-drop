import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  type CaptureContext,
  type CapturePage,
  type CaptureRoute,
  captureCanvas,
  encodeRenditions,
  RENDITION_SIZES,
} from "./capture.js";
import { CAPTURE_TOKEN_HEADER } from "./capture-token.js";

/** A real PNG at the capture viewport size so the sharp pipeline runs for real. */
const masterPng = (): Promise<Buffer> =>
  sharp({ create: { width: 1200, height: 630, channels: 3, background: { r: 12, g: 34, b: 56 } } })
    .png()
    .toBuffer();

function fakePage(over: Partial<CapturePage> = {}): {
  page: CapturePage;
  routeHandler: () => (route: CaptureRoute) => unknown;
  headers: () => Record<string, string>;
  closed: () => boolean;
} {
  let handler: (route: CaptureRoute) => unknown = () => {};
  let headers: Record<string, string> = {};
  let closed = false;
  const page: CapturePage = {
    async setExtraHTTPHeaders(h) {
      headers = h;
    },
    async route(_pattern, h) {
      handler = h;
    },
    on() {},
    async setViewportSize() {},
    async goto() {
      return null;
    },
    async screenshot() {
      return new Uint8Array(await masterPng());
    },
    async close() {
      closed = true;
    },
    ...over,
  };
  return { page, routeHandler: () => handler, headers: () => headers, closed: () => closed };
}

const ctxFor = (page: CapturePage): CaptureContext => ({ newPage: async () => page });

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
    const samePost = route("https://cv.example.test/_canvas/ai", "POST"); // AI primitive
    const crossGet = route("https://evil.example/x", "GET"); // external fetch / SSRF
    handler(sameGet.r);
    handler(samePost.r);
    handler(crossGet.r);
    expect(sameGet.cont()).toBe(true);
    expect(sameGet.abr()).toBe(false);
    expect(samePost.abr()).toBe(true); // no AI spend
    expect(crossGet.abr()).toBe(true); // no outbound network
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
});
