import type { Logger } from "../log/logger.js";

/**
 * Screenshot capture trigger (plan 004 / U12). The single effective-gated, best-effort
 * entry point that every publish path calls (`draftService.publish` and the deploy /
 * mcp / management paths in U13). It owns the enablement check so callers don't repeat
 * it — and so a caller can never accidentally bypass the admin off switch by reading the
 * bare env flag.
 *
 * Best-effort by contract: it checks `effectiveScreenshotsEnabled()` (env-available AND
 * admin-enabled), enqueues a coalesced capture if on, and **never throws** — a publish
 * must succeed even if scheduling a (cosmetic) preview fails.
 */
export interface ScreenshotTriggerDeps {
  /** The org-wide effective gate (adminSettingsService.effectiveScreenshotsEnabled). */
  enabled: () => Promise<boolean>;
  /** The jobs repository's coalescing enqueue. */
  repo: { enqueue(canvasId: string, versionId: string): Promise<void> };
  log: Logger;
}

export interface ScreenshotTrigger {
  /** Schedule a capture of `versionId` for the canvas — gated + best-effort. Skipped
   *  unless the canvas's `previewMode` is `auto`: an `off` canvas opts out, and a
   *  `custom` (owner-uploaded) preview must never be overwritten by a publish capture. */
  enqueue(canvas: { id: string; previewMode: string }, versionId: string): Promise<void>;
}

export function screenshotTrigger(deps: ScreenshotTriggerDeps): ScreenshotTrigger {
  return {
    async enqueue(canvas, versionId) {
      try {
        if (canvas.previewMode !== "auto") return; // off / custom → never auto-capture
        if (!(await deps.enabled())) return; // off (env-unavailable or admin-disabled) → no-op
        await deps.repo.enqueue(canvas.id, versionId);
      } catch (err) {
        deps.log.warn({ err, canvasId: canvas.id }, "screenshot enqueue failed (best-effort)");
      }
    },
  };
}
