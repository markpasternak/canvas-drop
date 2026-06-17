import sharp from "sharp";
import type { ScreenshotRendition } from "../canvas/storage-keys.js";
import { CAPTURE_TOKEN_HEADER } from "./capture-token.js";

/**
 * Capture engine (plan 004 / U4). Renders one canvas (at a pinned version) in a
 * provided, already-open browser context and produces the WebP preview renditions.
 *
 * The worker (U5) owns the single persistent browser and its lifecycle (KTD-4); this
 * function takes a fresh `BrowserContext` per job, drives one page, and returns the
 * encoded bytes — it never launches or closes the browser. Structurally-typed against
 * a minimal {@link CaptureContext} so it is unit-testable with a fake page (no real
 * Chromium); the worker passes a real Playwright context cast to this shape.
 *
 * Safety (KTD-5 / R7): primitives + outbound network are **neutered** — only
 * same-origin GETs (the canvas's own static assets) are allowed; everything else
 * (cross-origin fetch, same-origin POSTs = AI/KV writes, WebSocket upgrades) is
 * aborted. So a capture makes no AI spend and cannot reach the internal network.
 * Dialogs are auto-dismissed; a hard wall-clock timeout bounds a slow/looping canvas.
 */

/** Encoded viewport (the OG master is taken at this size). */
export const CAPTURE_VIEWPORT = { width: 1200, height: 630 } as const;

/** Target pixel size per rendition (sharp `cover` crop from the master). `card`/`thumb`
 *  are 16:9 to match the dashboard/gallery cover regions (no off-aspect cropping);
 *  `og` stays the 1200x630 link-unfurl standard. */
export const RENDITION_SIZES: Record<ScreenshotRendition, { width: number; height: number }> = {
  og: { width: 1200, height: 630 },
  card: { width: 1200, height: 675 },
  thumb: { width: 400, height: 225 },
};

const WEBP_QUALITY = 80;

// ── Minimal structural types (real Playwright Page/Context satisfy these) ──────
export interface CaptureRoute {
  request(): { url(): string; method(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
}
export interface CapturePage {
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  route(pattern: string, handler: (route: CaptureRoute) => unknown): Promise<void>;
  on(event: "dialog", handler: (d: { dismiss(): Promise<void> }) => unknown): void;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  screenshot(opts?: { type?: "png"; timeout?: number }): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface CaptureContext {
  newPage(): Promise<CapturePage>;
}

export interface CaptureInput {
  context: CaptureContext;
  /** Fully-resolved internal URL to render (the worker resolves URL mode). */
  url: string;
  /** Server-minted capture token (U3); presented as the internal capture header. */
  token: string;
  /** Hard wall-clock timeout (ms) for load + screenshot. */
  timeoutMs: number;
}

export type CaptureResult = Record<ScreenshotRendition, Uint8Array>;

/** Render `url` and return the encoded WebP renditions. Throws on timeout/failure;
 *  always closes the page it opened (the browser/context belong to the caller). */
export async function captureCanvas(input: CaptureInput): Promise<CaptureResult> {
  const origin = new URL(input.url).origin;
  const page = await input.context.newPage();
  try {
    // Dialogs would otherwise block the page (and the worker) indefinitely.
    page.on("dialog", (d) => {
      void d.dismiss();
    });
    await page.setExtraHTTPHeaders({ [CAPTURE_TOKEN_HEADER]: input.token });
    // Neuter (R7): allow only the canvas's own static GETs. Abort cross-origin and
    // non-GET (AI/KV writes), AND same-origin GETs to the runtime/primitive API
    // (`/v1/...`) so a captured canvas's JS can't read KV/files/me() as the
    // owner-equivalent capture principal during render — the "primitives are neutered"
    // invariant covers reads too, not just writes (review #4/#5). Static assets and the
    // SDK (`/sdk/...`) stay allowed.
    await page.route("**/*", (route) => {
      const req = route.request();
      let pathname = "";
      try {
        pathname = new URL(req.url()).pathname;
      } catch {}
      const allowed =
        req.method() === "GET" && req.url().startsWith(origin) && !pathname.startsWith("/v1/");
      void (allowed ? route.continue() : route.abort());
    });
    await page.setViewportSize({ ...CAPTURE_VIEWPORT });
    await page.goto(input.url, { waitUntil: "networkidle", timeout: input.timeoutMs });
    // Bound the screenshot too — a canvas that reaches networkidle then wedges the
    // renderer (rAF loop, deferred paint) must not hang the worker tick (review #3).
    const master = await page.screenshot({ type: "png", timeout: input.timeoutMs });
    return await encodeRenditions(master);
  } finally {
    await page.close().catch(() => {});
  }
}

/** sharp: PNG master → one WebP per rendition (`cover` crop to each target size). */
export async function encodeRenditions(masterPng: Uint8Array): Promise<CaptureResult> {
  const out = {} as CaptureResult;
  for (const rendition of Object.keys(RENDITION_SIZES) as ScreenshotRendition[]) {
    const { width, height } = RENDITION_SIZES[rendition];
    const buf = await sharp(masterPng)
      .resize(width, height, { fit: "cover" })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    out[rendition] = new Uint8Array(buf);
  }
  return out;
}
