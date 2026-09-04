import { ArrowSquareOut, Copy, PencilSimple, UsersThree } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { CanvasListItem } from "../lib/api.js";
import { formatBytes, fullTime, relativeTime } from "../lib/format.js";
import { AccessBadge, PublicationBadge } from "./Badge.js";
import { CanvasCover, previewCoverUrl } from "./CanvasCover.js";
import { canvasTitle, lastActivity, visibilityLabel } from "./CanvasList.js";
import { coverType } from "./GenerativeCover.js";

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
  const active = canvas.status === "active";
  const published = active && canvas.publicationState === "published" && !!canvas.currentVersionId;
  const draftLabel = deploy ? "Edit draft" : "Continue setup";
  const draftAriaLabel = deploy ? `Edit draft for ${title}` : `Continue setup for ${title}`;
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
        <h2 className="font-display text-lg text-fg">{title}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <PublicationBadge state={canvas.publicationState} />
          <AccessBadge access={canvas.access} />
        </div>
      </div>

      {/* The next useful action follows the canvas lifecycle, not its history. */}
      <div className="flex flex-col gap-2">
        {published && (
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
        )}
        {active ? (
          <>
            <div className={published ? "grid grid-cols-2 gap-2" : ""}>
              <Link
                to="/canvases/$id/editor"
                params={{ id: canvas.id }}
                className={published ? secondaryClass : primaryClass}
                aria-label={draftAriaLabel}
              >
                <PencilSimple size={14} weight="bold" aria-hidden />
                {draftLabel}
              </Link>
              {published && (
                <Link
                  to="/canvases/$id/share"
                  params={{ id: canvas.id }}
                  className={secondaryClass}
                  aria-label={`Share ${title}`}
                >
                  <UsersThree size={14} weight="bold" aria-hidden />
                  Share
                </Link>
              )}
            </div>
            {!published && (
              <p className="text-xs leading-relaxed text-muted">
                Publish the draft to share a live link.
              </p>
            )}
          </>
        ) : (
          <p className="rounded-md bg-surface-sunken p-3 text-sm leading-relaxed text-muted">
            {canvas.status === "archived"
              ? "This canvas is archived. Open its details to unarchive and resume work."
              : "This canvas is disabled. Open its details for the reason and next steps."}
          </p>
        )}
      </div>

      <dl className="divide-y divide-border/60 border-y border-border/60 py-1">
        <DetailRow
          label="Updated"
          value={relativeTime(lastActivity(canvas))}
          title={fullTime(lastActivity(canvas))}
        />
        {deploy && (
          <>
            <DetailRow
              label={`${published ? "Live" : "Saved"} version v${deploy.version}`}
              value={relativeTime(deploy.createdAt)}
              title={fullTime(deploy.createdAt)}
            />
            <DetailRow
              label="Version files"
              value={`${deploy.fileCount} ${deploy.fileCount === 1 ? "file" : "files"} · ${formatBytes(deploy.totalBytes)}`}
            />
          </>
        )}
      </dl>

      <details className="text-xs text-muted">
        <summary className="cursor-pointer rounded-md py-1.5 font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          More details
        </summary>
        <dl className="mt-1 divide-y divide-border/60">
          <DetailRow label="Visibility" value={visibilityLabel(canvas)} />
          <DetailRow
            label="Created"
            value={relativeTime(canvas.createdAt)}
            title={fullTime(canvas.createdAt)}
          />
        </dl>
      </details>

      <div className="flex items-center justify-between gap-3 text-xs">
        <Link
          to="/canvases/$id"
          params={{ id: canvas.id }}
          className="rounded-md py-2 font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/50"
          aria-label={`Full details for ${title}`}
        >
          Full details
        </Link>
        {active && onDuplicate && (
          <button
            type="button"
            onClick={onDuplicate}
            className="inline-flex items-center gap-1.5 rounded-md py-2 text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50"
            aria-label={`Duplicate ${title}`}
          >
            <Copy size={14} aria-hidden />
            Duplicate
          </button>
        )}
      </div>
    </aside>
  );
}
