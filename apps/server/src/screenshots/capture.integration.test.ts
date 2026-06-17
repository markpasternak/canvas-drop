import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaptureContext } from "./capture.js";
import { captureCanvas, RENDITION_SIZES } from "./capture.js";

/**
 * Real-Chromium proof for the capture engine (plan 004 / U4). Drives a genuine
 * headless browser against a tiny local HTTP page. Gated on env so it runs only when
 * an operator opts in (and Chromium is installed) — skipped in CI / by default, like
 * `integration/real-infra.test.ts`. Run locally with:
 *   CANVAS_DROP_TEST_SCREENSHOTS=1 pnpm exec vitest run apps/server/src/screenshots/capture.integration.test.ts
 */
const RUN = process.env.CANVAS_DROP_TEST_SCREENSHOTS === "1";

describe.skipIf(!RUN)("captureCanvas — real Chromium (opt-in)", () => {
  let server: Server;
  let origin: string;
  // biome-ignore lint/suspicious/noExplicitAny: Playwright Browser, loaded dynamically when opted in.
  let browser: any;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><body style='background:#123'><h1>hi</h1></body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("captures a real page into valid WebP renditions", async () => {
    const context = (await browser.newContext()) as unknown as CaptureContext;
    const out = await captureCanvas({
      context,
      url: `${origin}/`,
      token: "tok",
      timeoutMs: 15_000,
    });
    const og = await sharp(out.og).metadata();
    expect(og.format).toBe("webp");
    expect(og.width).toBe(RENDITION_SIZES.og.width);
    // biome-ignore lint/suspicious/noExplicitAny: real Playwright context close
    await (context as any).close();
  });
});
