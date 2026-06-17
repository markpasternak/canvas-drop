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
/** Max time to wait for a browser `close()` before dropping the handle (review #3). */
const CLOSE_TIMEOUT_MS = 10_000;

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
  /** Resolve the internal URL to render for a canvas (URL-mode aware; injected). In
   *  subdomain mode this is the canvas's subdomain URL, resolved to the loopback server
   *  by the browser's host-resolver rules (set at launch in index.ts). */
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
      launching = deps
        .launchBrowser()
        .then((b) => {
          browser = b;
          launching = null;
          jobsSinceLaunch = 0;
          return b;
        })
        .catch((err) => {
          // Reset the shared launch pointer so a failed launch (e.g. env-on but no
          // Chromium, or a transient OOM) is retried on the next job, instead of
          // memoizing a rejected promise that poisons the worker forever (review #1).
          launching = null;
          throw err;
        });
    }
    return launching;
  }

  /** Close the browser (between ticks only, never mid-job) so the next job relaunches.
   *  Bounded by a timeout so a wedged Chromium whose close() hangs can't stall the tick
   *  loop or the SIGTERM drain (review #3) — we drop the handle and move on regardless. */
  async function recycle(): Promise<void> {
    const b = browser;
    browser = null;
    needsRecycle = false;
    jobsSinceLaunch = 0;
    if (!b) return;
    await Promise.race([
      b.close().catch(() => {}),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        (t as { unref?: () => void }).unref?.();
      }),
    ]);
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
          job.leasedAt as number,
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
        await deps.jobs.markDone(job.id, job.leasedAt as number);
        jobsSinceLaunch += 1;
      } finally {
        await context.close().catch(() => {});
      }
    } catch (err) {
      // Mark for recycle BEFORE the DB write — if markFailedOrRetry itself throws
      // (DB down), the flag is still set so the (possibly wedged) browser is recycled;
      // the job stays `running` and self-heals via reclaimStuck on a later tick (#4).
      needsRecycle = true;
      deps.log.warn({ err, canvasId: job.canvasId }, "screenshot capture failed");
      await deps.jobs
        .markFailedOrRetry(
          job.id,
          String((err as Error)?.message ?? err),
          s.maxAttempts,
          job.leasedAt as number,
        )
        .catch((dbErr) =>
          deps.log.warn({ err: dbErr, canvasId: job.canvasId }, "markFailed failed"),
        );
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

    // Drain up to `concurrency` jobs against the single browser (default 1). NOTE: at
    // concurrency > 1 the per-slot claim (select-oldest then conditional update) can
    // race so slots contend for the same row and some no-op — effective parallelism is
    // bounded by that contention, not a hard N. Acceptable at the default of 1 on a
    // single-process VPS; a true N-way claim (e.g. UPDATE … RETURNING with a subselect /
    // SKIP LOCKED) is the upgrade path if higher throughput is ever needed (review P3).
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
