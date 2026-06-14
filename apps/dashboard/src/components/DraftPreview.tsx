import {
  ArrowClockwise,
  ArrowSquareOut,
  ArrowsIn,
  ArrowsOut,
  Browser,
  X,
} from "@phosphor-icons/react";
import { cn } from "../lib/cn.js";
import { IconButton, IconLink } from "./IconButton.js";
import { PaneHeader, WorkspacePane } from "./Surface.js";

export interface DraftPreviewProps {
  canvasId: string;
  /** Bumped by the parent to force a reload (e.g. after a save). */
  refreshKey: number;
  onRefresh: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** Hide the inline preview (omitted in the fullscreen overlay). */
  onHide?: () => void;
  /**
   * The draft ships JavaScript. The inline frame is sandboxed to an opaque origin, so
   * ES modules are CORS-blocked and the SDK's signed-in calls can't authenticate —
   * the page wouldn't run faithfully here. When set, we replace the frame with a
   * notice + an "Open full preview" CTA (the new tab is top-level and runs everything).
   */
  usesScripts?: boolean;
}

const iconBtn = "border-border bg-surface-raised text-muted hover:bg-surface-hover hover:text-fg";

/**
 * Owner-only draft preview (R13) of the **whole draft site** (its entry/index) — not
 * the selected file — pointed at the dashboard-origin preview route (U7). Mirrors
 * the StackBlitz/CodeSandbox preview: refresh, open-in-new-tab, full screen, hide.
 * `allow-same-origin` is intentionally absent so the draft runs in an opaque origin
 * and can't touch the dashboard session. That isolation means JS-driven canvases
 * can't run in the frame (ES modules are CORS-blocked from the null origin; signed-in
 * SDK calls can't send the session cookie), so for those we show a notice pointing at
 * the full top-level preview instead — see {@link usesScripts}.
 */
export function DraftPreview({
  canvasId,
  refreshKey,
  onRefresh,
  fullscreen,
  onToggleFullscreen,
  onHide,
  usesScripts = false,
}: DraftPreviewProps) {
  const src = `/api/canvases/${canvasId}/preview/?r=${refreshKey}`;
  // The full, live preview: top-level (not sandboxed), so scripts + signed-in calls run.
  const fullSrc = `/api/canvases/${canvasId}/preview/`;

  const openInNewTab = (
    <IconLink
      href={fullSrc}
      target="_blank"
      rel="noreferrer"
      className={iconBtn}
      label="Open full preview in new tab"
    >
      <ArrowSquareOut size={15} weight="bold" aria-hidden />
    </IconLink>
  );

  const hideButton = onHide && (
    <IconButton type="button" className={iconBtn} onClick={onHide} label="Hide preview">
      <X size={15} weight="bold" aria-hidden />
    </IconButton>
  );

  // Script-bearing drafts can't run in the sandbox, so the only useful controls are
  // open-in-new-tab + hide (refresh/full-screen act on the frame we're not showing).
  const controls = (
    <div className="flex shrink-0 items-center gap-1">
      {openInNewTab}
      {!usesScripts && (
        <>
          <IconButton type="button" className={iconBtn} onClick={onRefresh} label="Refresh preview">
            <ArrowClockwise size={15} weight="bold" aria-hidden />
          </IconButton>
          <IconButton
            type="button"
            className={iconBtn}
            onClick={onToggleFullscreen}
            label={fullscreen ? "Exit full screen preview" : "Full screen preview"}
          >
            {fullscreen ? (
              <ArrowsIn size={15} weight="bold" aria-hidden />
            ) : (
              <ArrowsOut size={15} weight="bold" aria-hidden />
            )}
          </IconButton>
        </>
      )}
      {hideButton}
    </div>
  );

  const header = (
    <PaneHeader
      leading={
        <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-surface-sunken text-subtle">
          <Browser size={15} weight="duotone" aria-hidden />
        </span>
      }
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span>Preview</span>
          <span className="rounded border border-border bg-surface-sunken px-1.5 py-0.5 text-[0.625rem] font-medium text-subtle">
            Draft
          </span>
        </span>
      }
      description={<span className="font-mono">/api/canvases/{canvasId}/preview/</span>}
      actions={controls}
    />
  );

  const frame = (
    <iframe
      key={refreshKey}
      title="Draft preview"
      src={src}
      className="h-full w-full bg-surface"
      sandbox="allow-scripts allow-forms"
    />
  );

  // Notice shown instead of the frame when the draft runs JavaScript. The static look
  // (HTML/CSS/images) is faithful in the sandbox, but scripts/signed-in calls aren't —
  // so we send the user to the live top-level preview.
  const scriptsNotice = (
    <div
      data-testid="preview-scripts-notice"
      className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-surface-sunken text-subtle">
        <Browser size={22} weight="duotone" aria-hidden />
      </span>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-fg">This canvas runs JavaScript</p>
        <p className="mx-auto max-w-[22rem] text-xs leading-relaxed text-subtle">
          The inline preview is sandboxed, so scripts and signed-in API calls don't run here (and
          self-hosted fonts may not load). HTML, CSS, and images still render. Open the full preview
          in a new tab to see it live.
        </p>
      </div>
      <a
        href={fullSrc}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-3.5 text-[0.8125rem] font-medium text-accent-fg shadow-[var(--shadow-xs)] transition-colors hover:bg-accent-hover"
      >
        <ArrowSquareOut size={15} weight="bold" aria-hidden />
        Open full preview
      </a>
    </div>
  );

  const body = usesScripts ? scriptsNotice : frame;

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-canvas/95 p-4 backdrop-blur-sm">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-popover)]">
          {header}
          <div className="min-h-0 flex-1">{frame}</div>
        </div>
      </div>
    );
  }

  return (
    <WorkspacePane className={cn("flex h-full min-w-0 flex-col")}>
      {header}
      <div className="min-h-0 flex-1">{body}</div>
    </WorkspacePane>
  );
}
