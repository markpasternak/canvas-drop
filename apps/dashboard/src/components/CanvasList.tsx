import { LockSimple } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { CanvasListItem } from "../lib/api.js";
import { formatBytes, relativeTime } from "../lib/format.js";
import { Badge, StatusBadge } from "./Badge.js";
import { CopyButton } from "./CopyButton.js";
import { Skeleton } from "./Skeleton.js";

/** Row indicators. "Active" is the boring default — only badge what's notable:
 * a non-active status (admin takedown, archived), the access signals (shared,
 * password), the gallery state, and the deployment state. Each badge mirrors a
 * Your-canvases filter (plan 004) so the list is scannable; a clean, private,
 * deployed canvas shows no pills. */
function RowBadges({ canvas }: { canvas: CanvasListItem }) {
  return (
    <>
      {canvas.status !== "active" && <StatusBadge status={canvas.status} />}
      {canvas.shared && <Badge tone="accent">Shared</Badge>}
      {canvas.hasPassword && (
        <Badge tone="neutral">
          <LockSimple size={12} weight="bold" aria-hidden />
          Protected
        </Badge>
      )}
      {/* Gallery state (plan 002). Template implies listed, so show the stronger
          one. Blockers/reasons live on the canvas Overview + Settings, not here. */}
      {canvas.galleryTemplatable ? (
        <Badge tone="accent">Template</Badge>
      ) : canvas.galleryListed ? (
        <Badge tone="neutral">Listed</Badge>
      ) : null}
      {/* Deployment state (plan 004). Only the notable "never deployed" state gets a
          pill; a clean, deployed canvas stays quiet. (has-unpublished-changes is
          deferred — see plan KTD6.) */}
      {canvas.lastDeploy === null && <Badge tone="warning">Never deployed</Badge>}
    </>
  );
}

/** The default trailing actions for a row in the active list: copy + open. */
export function DefaultRowActions({ canvas }: { canvas: CanvasListItem }) {
  return (
    <>
      <CopyButton value={canvas.url} label="Copy link" toastMessage="Link copied" />
      <a
        href={canvas.url}
        target="_blank"
        rel="noreferrer"
        className="rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:bg-surface-hover hover:text-accent"
      >
        Open
      </a>
    </>
  );
}

/** A single canvas row, reused by the active list and the archive view. The
 * `actions` slot controls the trailing controls — the active list shows
 * copy/open, the archive view shows restore/delete. */
export function CanvasRow({ canvas, actions }: { canvas: CanvasListItem; actions?: ReactNode }) {
  const title = canvas.title?.trim() || canvas.slug;
  return (
    <li className="group flex items-center gap-4 rounded-xl border border-border bg-surface px-4 py-3 shadow-[var(--shadow-panel)] transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:border-border-strong hover:bg-surface-raised">
      <Link to="/canvases/$id" params={{ id: canvas.id }} className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-fg">{title}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <RowBadges canvas={canvas} />
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
          <span className="truncate font-mono">{canvas.slug}</span>
          {/* Deploy stats when published; the never-deployed state is shown as a
              badge above (plan 004), so the meta line just omits stats here. */}
          {canvas.lastDeploy && (
            <>
              <span>v{canvas.lastDeploy.version}</span>
              <span>{relativeTime(canvas.lastDeploy.createdAt)}</span>
              <span>{formatBytes(canvas.lastDeploy.totalBytes)}</span>
              <span>
                {canvas.lastDeploy.fileCount} {canvas.lastDeploy.fileCount === 1 ? "file" : "files"}
              </span>
            </>
          )}
        </div>
      </Link>
      <div className="flex shrink-0 items-center gap-1">
        {actions ?? <DefaultRowActions canvas={canvas} />}
      </div>
    </li>
  );
}

export function ListSkeleton() {
  return (
    <ul className="space-y-2" aria-hidden>
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="flex items-center gap-4 rounded-xl border border-border bg-surface px-4 py-3"
        >
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-6 w-20" />
        </li>
      ))}
    </ul>
  );
}
