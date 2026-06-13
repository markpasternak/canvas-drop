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
}

const iconBtn = "border-border bg-surface-raised text-muted hover:bg-surface-hover hover:text-fg";

/**
 * Owner-only draft preview (R13) of the **whole draft site** (its entry/index) — not
 * the selected file — pointed at the dashboard-origin preview route (U7). Mirrors
 * the StackBlitz/CodeSandbox preview: refresh, open-in-new-tab, full screen, hide.
 * `allow-same-origin` is intentionally absent so the draft runs in an opaque origin
 * and can't touch the dashboard session.
 */
export function DraftPreview({
  canvasId,
  refreshKey,
  onRefresh,
  fullscreen,
  onToggleFullscreen,
  onHide,
}: DraftPreviewProps) {
  const src = `/api/canvases/${canvasId}/preview/?r=${refreshKey}`;

  const controls = (
    <div className="flex shrink-0 items-center gap-1">
      <IconLink
        href={src}
        target="_blank"
        rel="noreferrer"
        className={iconBtn}
        label="Open draft preview in new tab"
      >
        <ArrowSquareOut size={15} weight="bold" aria-hidden />
      </IconLink>
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
      {onHide && (
        <IconButton type="button" className={iconBtn} onClick={onHide} label="Hide preview">
          <X size={15} weight="bold" aria-hidden />
        </IconButton>
      )}
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
      className="h-full w-full bg-white"
      sandbox="allow-scripts allow-forms"
    />
  );

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
      <div className="min-h-0 flex-1">{frame}</div>
    </WorkspacePane>
  );
}
