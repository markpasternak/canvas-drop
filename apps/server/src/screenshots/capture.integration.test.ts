import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CaptureContext } from "./capture.js";
import { captureCanvas, RENDITION_SIZES } from "./capture.js";
import { launchChromiumWithChromeFallback } from "./playwright-browser.js";

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

  const seenHosts: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.headers.host) seenHosts.push(req.headers.host);
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><body style='background:#123'><h1>hi</h1></body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { chromium } = await import("playwright");
    browser = await launchChromiumWithChromeFallback(chromium);
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

  // R3: subdomain-mode capture hits the canvas's real subdomain URL, which the
  // browser's host-resolver rules map to the loopback server. This proves the
  // mechanism end-to-end: a browser launched with `--host-resolver-rules=MAP <host>
  // 127.0.0.1:<port>` reaches our loopback server AND the request carries the real
  // subdomain Host (so resolveRequest would pick the right canvas).
  it("reaches the loopback server with the right Host via host-resolver-rules", async () => {
    seenHosts.length = 0;
    const port = (server.address() as AddressInfo).port;
    const fakeHost = "quiet-otter.canvases.example.com";
    const { chromium } = await import("playwright");
    const mapped = await launchChromiumWithChromeFallback(chromium, {
      args: [`--host-resolver-rules=MAP ${fakeHost} 127.0.0.1:${port}`],
    });
    try {
      const context = (await mapped.newContext()) as unknown as CaptureContext;
      const out = await captureCanvas({
        context,
        url: `http://${fakeHost}/`, // resolves to the loopback server
        token: "tok",
        timeoutMs: 15_000,
      });
      expect((await sharp(out.og).metadata()).format).toBe("webp");
      expect(seenHosts).toContain(fakeHost); // server saw the real subdomain Host
    } finally {
      await mapped.close();
    }
  });
});
