import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { SCREENSHOT_RENDITIONS, screenshotKey } from "../canvas/storage-keys.js";
import type { ScreenshotsRepository } from "../db/repositories/screenshots.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";
import {
  type CaptureContext,
  type CaptureInput,
  type CaptureResult,
  captureCanvas,
} from "./capture.js";
import { mintCaptureToken } from "./capture-token.js";

/**
 * Screenshot worker (plan 004 / U5). The in-process loop that drains the
 * `screenshot_jobs` queue using ONE persistent browser (KTD-4): a fresh context per
 * job, closed after; the browser is reused for the process lifetime and recycled
 * every N jobs (and after a failure that may have wedged it). Concurrency is the
 * number of contexts processed per tick (default 1, env-configurable).
 *
 * Gated by `effectiveScreenshotsEnabled()` (U12): when the admin toggle is off the
 * tick still does cheap reclaim/sweep bookkeeping but launches no browser and claims
 * no work. The whole worker is only *started* when the env makes capture available.
 */
export interface CaptureBrowser {
  newContext(): Promise<CaptureContext & { close(): Promise<void> }>;
  close(): Promise<void>;
}

export interface ScreenshotWorkerDeps {
  config: Config;
  /** The org-wide effective gate (adminSettingsService.effectiveScreenshotsEnabled). */
  enabled: () => Promise<boolean>;
  jobs: Pick<
    ScreenshotsRepository,
    "claimNext" | "markDone" | "markFailedOrRetry" | "reclaimStuck" | "sweepFailed"
  >;
  canvases: { findById(id: string): Promise<Canvas | null> };
  storage: Pick<StorageDriver, "put">;
  /** Resolve the internal URL to render for a canvas (URL-mode aware; injected). */
  captureUrlFor: (canvas: Canvas) => string;
  /** Launch the persistent browser (injectable; default Playwright chromium). */
  launchBrowser: () => Promise<CaptureBrowser>;
  /** Per-job capture (injectable for tests); defaults to the real engine. */
  capture?: (input: CaptureInput) => Promise<CaptureResult>;
  log: Logger;
  now?: () => number;
}

export interface ScreenshotWorker {
  /** Run one bookkeeping+drain cycle (exposed for tests + the interval). */
  tick(): Promise<void>;
  /** Stop and close the browser (graceful shutdown). */
  stop(): Promise<void>;
}

export function screenshotWorker(deps: ScreenshotWorkerDeps): ScreenshotWorker {
  const s = deps.config.screenshots;
  const now = deps.now ?? Date.now;
  const capture = deps.capture ?? captureCanvas;

  let browser: CaptureBrowser | null = null;
  let launching: Promise<CaptureBrowser> | null = null;
  let jobsSinceLaunch = 0;
  let needsRecycle = false;

  /** Lazily launch the single browser; concurrent callers share one launch. */
  async function ensureBrowser(): Promise<CaptureBrowser> {
    if (browser) return browser;
    if (!launching) {
      launching = deps.launchBrowser().then((b) => {
        browser = b;
        launching = null;
        jobsSinceLaunch = 0;
        return b;
      });
    }
    return launching;
  }

  /** Close the browser (between ticks only, never mid-job) so the next job relaunches. */
  async function recycle(): Promise<void> {
    const b = browser;
    browser = null;
    needsRecycle = false;
    jobsSinceLaunch = 0;
    await b?.close().catch(() => {});
  }

  /** Claim and process one job; returns false when the queue is empty. */
  async function processOne(): Promise<boolean> {
    const t = now();
    const job = await deps.jobs.claimNext(t, t - s.leaseMs);
    if (!job) return false;
    try {
      const canvas = await deps.canvases.findById(job.canvasId);
      if (!canvas || canvas.status !== "active") {
        await deps.jobs.markFailedOrRetry(
          job.id,
          `canvas not capturable: ${job.canvasId}`,
          s.maxAttempts,
        );
        return true;
      }
      const b = await ensureBrowser();
      const context = await b.newContext();
      try {
        const token = mintCaptureToken(
          deps.config.sessionSecret,
          job.canvasId,
          job.versionId,
          s.tokenTtlMs,
        );
        const renditions = await capture({
          context,
          url: deps.captureUrlFor(canvas),
          token,
          timeoutMs: s.timeoutMs,
        });
        for (const rendition of SCREENSHOT_RENDITIONS) {
          await deps.storage.put(screenshotKey(job.canvasId, rendition), renditions[rendition], {
            contentType: "image/webp",
          });
        }
        await deps.jobs.markDone(job.id);
        jobsSinceLaunch += 1;
      } finally {
        await context.close().catch(() => {});
      }
    } catch (err) {
      deps.log.warn({ err, canvasId: job.canvasId }, "screenshot capture failed");
      await deps.jobs.markFailedOrRetry(
        job.id,
        String((err as Error)?.message ?? err),
        s.maxAttempts,
      );
      needsRecycle = true; // a failed job may have wedged the browser
    }
    return true;
  }

  async function tick(): Promise<void> {
    const t = now();
    // Cheap bookkeeping runs every tick regardless of the admin toggle: reclaim leases
    // a crashed/restarted worker dropped, and reclaim permanently-failed rows past TTL.
    await deps.jobs
      .reclaimStuck(t - s.leaseMs)
      .catch((err) => deps.log.warn({ err }, "reclaim failed"));
    await deps.jobs
      .sweepFailed(t - s.failedTtlMs)
      .catch((err) => deps.log.warn({ err }, "sweepFailed failed"));

    // Admin toggle off → do no work and launch no browser (U12).
    if (!(await deps.enabled())) return;

    // Drain up to `concurrency` jobs against the single browser (default 1).
    const slots = Math.max(1, s.concurrency);
    const results = await Promise.all(Array.from({ length: slots }, () => processOne()));

    // Recycle between ticks only (never mid-job): after enough jobs, or if one wedged.
    if (results.some(Boolean) && (needsRecycle || jobsSinceLaunch >= s.recycleEvery)) {
      await recycle();
    }
  }

  return {
    tick,
    async stop() {
      await recycle();
    },
  };
}

/**
 * Start the worker on an interval and return a stop handle — only when the env makes
 * capture AVAILABLE (Chromium present). When unavailable, capture is fully inert (no
 * interval, no browser) and the product behaves exactly like today. Wired from index.ts.
 */
export function startScreenshotWorker(
  deps: ScreenshotWorkerDeps,
  intervalMs = 2000,
): { stop(): Promise<void> } {
  if (!deps.config.screenshots.available) {
    return { async stop() {} };
  }
  const worker = screenshotWorker(deps);
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // never overlap ticks
    running = true;
    worker
      .tick()
      .catch((err) => deps.log.warn({ err }, "screenshot worker tick failed"))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return {
    async stop() {
      clearInterval(timer);
      await worker.stop();
    },
  };
}
