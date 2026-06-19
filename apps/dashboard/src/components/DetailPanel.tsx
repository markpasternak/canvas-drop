import { ArrowSquareOut, Copy, DotsThree, UsersThree } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { CanvasListItem } from "../lib/api.js";
import { fullTime, relativeTime } from "../lib/format.js";
import { AccessBadge, accessRungLabel, PublicationBadge } from "./Badge.js";
import { CanvasCover, previewCoverUrl } from "./CanvasCover.js";
import { canvasTitle, lastActivity, visibilityLabel } from "./CanvasList.js";
import { coverType } from "./GenerativeCover.js";

const PUBLICATION_LABEL: Record<CanvasListItem["publicationState"], string> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
  disabled: "Disabled",
  deleted: "Deleted",
};

const actionBase =
  "inline-flex h-9 w-full items-center justify-center gap-2 rounded-md px-3 text-[0.8125rem] " +
  "font-medium transition-colors duration-100 [transition-timing-function:var(--ease-out)] " +
  "outline-none focus-visible:ring-2 focus-visible:ring-accent/50";

/** The single coloured CTA — the teal accent moment in the rail. */
const primaryClass = `${actionBase} bg-accent text-accent-fg hover:bg-accent-hover`;

/** Flat secondary actions — no raised card, just a quiet hairline + subtle hover. */
const secondaryClass = `${actionBase} border border-border text-fg hover:bg-surface-sunken`;

function DetailRow({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-xs text-subtle">{label}</dt>
      <dd className="min-w-0 truncate text-right text-xs font-medium text-fg" title={title}>
        {value}
      </dd>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="text-[0.6875rem] font-medium uppercase tracking-wide text-subtle">
      {children}
    </div>
  );
}

/**
 * The right-rail "living object" panel for a single focused canvas (plan P4 / U2).
 * Presentational only — it does not own selection or the clone flow; the route
 * wires `onDuplicate` to the shared `CloneDialog` (U4) and renders this beside the
 * library (U3). Reuses only exported helpers (title, badges, format, cover) so the
 * list and the rail never drift.
 */
export function DetailPanel({
  canvas,
  onDuplicate,
}: {
  canvas: CanvasListItem | null;
  /** Wired by the route to open the shared CloneDialog (U4). Absent → no Duplicate. */
  onDuplicate?: () => void;
}) {
  if (!canvas) {
    return (
      <aside
        aria-label="Canvas details"
        className="flex h-full flex-col items-center justify-center p-6 text-center"
      >
        <p className="text-sm text-subtle">Select a canvas to see details.</p>
      </aside>
    );
  }

  const title = canvasTitle(canvas);
  const deploy = canvas.lastDeploy;
  const previewUrl = canvas.hasPreview
    ? `${previewCoverUrl(canvas.url, "thumb")}&v=${canvas.updatedAt}`
    : undefined;

  return (
    <aside aria-label="Canvas details" className="flex h-full flex-col gap-4 overflow-y-auto">
      {/* Hero cover */}
      <div className="aspect-[3/2] w-full overflow-hidden rounded-lg border border-border/60 bg-surface-sunken">
        <CanvasCover
          seed={canvas.id}
          title={title}
          type={coverType({
            templatable: canvas.galleryTemplatable,
            listed: canvas.galleryListed,
            protectedByPassword: canvas.hasPassword,
          })}
          status={canvas.publicationState}
          previewUrl={previewUrl}
        />
      </div>

      {/* Title + status */}
      <div className="flex flex-col gap-2">
        <h2 className="font-serif text-lg font-medium text-fg">{title}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <PublicationBadge state={canvas.publicationState} />
          <AccessBadge access={canvas.access} />
        </div>
      </div>

      {/* Primary actions */}
      <div className="flex flex-col gap-2">
        {deploy ? (
          <a
            href={canvas.url}
            target="_blank"
            rel="noreferrer"
            className={primaryClass}
            aria-label={`Open ${title}`}
          >
            Open
            <ArrowSquareOut size={14} weight="bold" aria-hidden />
          </a>
        ) : (
          <Link
            to="/canvases/$id/editor"
            params={{ id: canvas.id }}
            className={primaryClass}
            aria-label={`Continue setup for ${title}`}
          >
            Continue setup
          </Link>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Link
            to="/canvases/$id/share"
            params={{ id: canvas.id }}
            className={secondaryClass}
            aria-label={`Share ${title}`}
          >
            Share
            <UsersThree size={14} weight="bold" aria-hidden />
          </Link>
          <button
            type="button"
            onClick={onDuplicate}
            disabled={!onDuplicate}
            className={`${secondaryClass} disabled:opacity-50 disabled:pointer-events-none`}
            aria-label={`Duplicate ${title}`}
          >
            Duplicate
            <Copy size={14} weight="bold" aria-hidden />
          </button>
        </div>
        <Link
          to="/canvases/$id"
          params={{ id: canvas.id }}
          className={secondaryClass}
          aria-label={`Manage ${title}`}
        >
          Manage
          <DotsThree size={16} weight="bold" aria-hidden />
        </Link>
      </div>

      {/* Details list */}
      <div className="flex flex-col gap-1">
        <SectionTitle>Details</SectionTitle>
        <dl className="divide-y divide-border/60">
          <DetailRow label="Access" value={accessRungLabel(canvas.access)} />
          <DetailRow label="Visibility" value={visibilityLabel(canvas)} />
          <DetailRow label="Status" value={PUBLICATION_LABEL[canvas.publicationState]} />
          <DetailRow
            label="Edited"
            value={relativeTime(lastActivity(canvas))}
            title={fullTime(lastActivity(canvas))}
          />
          <DetailRow
            label="Created"
            value={relativeTime(canvas.createdAt)}
            title={fullTime(canvas.createdAt)}
          />
        </dl>
      </div>

      {/* Recent activity (derived; full feed deferred) */}
      <div className="flex flex-col gap-1">
        <SectionTitle>Recent activity</SectionTitle>
        <ul className="flex flex-col gap-1 text-xs text-muted">
          {deploy && (
            <li title={fullTime(deploy.createdAt)}>
              Published v{deploy.version} · {relativeTime(deploy.createdAt)}
            </li>
          )}
          <li title={fullTime(canvas.updatedAt)}>Edited {relativeTime(canvas.updatedAt)}</li>
        </ul>
      </div>
    </aside>
  );
}
