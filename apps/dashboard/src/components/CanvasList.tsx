import { ArrowSquareOut, LockSimple } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { CanvasListItem } from "../lib/api.js";
import { fullTime, relativeTime } from "../lib/format.js";
import { rowPrimaryActionClass } from "../lib/row-styles.js";
import { AccessBadge, Badge, PublicationBadge } from "./Badge.js";
import { CanvasCover, previewCoverUrl } from "./CanvasCover.js";
import { CopyButton } from "./CopyButton.js";
import { Skeleton } from "./Skeleton.js";

const MAX_ROW_TAGS = 3;

/** Display title: the trimmed title, or the slug as a stable fallback. Shared so
 * the Your-canvases route renders identical titles to the list rows. */
export function canvasTitle(canvas: CanvasListItem): string {
  return canvas.title?.trim() || canvas.slug;
}

function canvasTags(canvas: CanvasListItem): string[] {
  return Array.isArray(canvas.galleryTags)
    ? canvas.galleryTags.filter((t): t is string => typeof t === "string")
    : [];
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    ? Boolean(target.closest("a, button, input, select, textarea, summary, [role='button']"))
    : false;
}

function RowBadges({ canvas }: { canvas: CanvasListItem }) {
  return (
    <>
      {/* Surface the lifecycle near the title only when it's not the happy
          Published state — the Publication column carries the full detail. */}
      {canvas.publicationState !== "published" && (
        <PublicationBadge state={canvas.publicationState} />
      )}
      {/* Public is the only beyond-the-org rung — flag it prominently by the title. */}
      {canvas.access === "public_link" && <AccessBadge access="public_link" />}
      {canvas.galleryTemplatable && <Badge tone="accent">Template</Badge>}
      {/* Listed-but-not-template: gallery state used to be its own column. */}
      {canvas.galleryListed && !canvas.galleryTemplatable && <Badge tone="neutral">Listed</Badge>}
      {canvas.hasPassword && (
        <Badge tone="neutral">
          <LockSimple size={12} weight="bold" aria-hidden />
          Protected
        </Badge>
      )}
    </>
  );
}

function RowTags({ tags }: { tags: string[] }) {
  if (tags.length === 0) {
    return <span className="text-subtle">No tags</span>;
  }
  const shown = tags.slice(0, MAX_ROW_TAGS);
  const extra = tags.length - shown.length;
  const chip =
    "rounded border border-border bg-surface-sunken px-1.5 py-0.5 text-[0.6875rem] font-medium";
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((tag) => (
        <span key={tag} className={`${chip} text-muted`}>
          {tag}
        </span>
      ))}
      {extra > 0 && (
        <span className={`${chip} text-subtle`} title={`${extra} more tags`}>
          +{extra}
        </span>
      )}
    </span>
  );
}

function visibility(canvas: CanvasListItem): { primary: string; secondary: string } {
  const gated = canvas.hasPassword;
  switch (canvas.access) {
    case "public_link":
      // Public ignores the password gate for anonymous visitors? No — public_link
      // still honors a password; but the headline is the exposure, so lead with it.
      return { primary: "Public", secondary: gated ? "Anyone (password)" : "Anyone with the link" };
    case "whole_org":
      return {
        primary: gated ? "Whole org + protected" : "Whole org",
        secondary: gated ? "Password required" : "Org members",
      };
    case "specific_people":
      return {
        primary: gated ? "Specific people + protected" : "Specific people",
        secondary: gated ? "Password required" : "Invited only",
      };
    default:
      return { primary: "Private", secondary: "Owner only" };
  }
}

/** Most recent activity on a canvas: the later of its last edit (settings/deploy
 *  bump `updatedAt`) and its last publish. Drives the "Edited …" row hint. */
function lastActivity(canvas: CanvasListItem): number {
  return Math.max(canvas.updatedAt, canvas.lastDeploy?.createdAt ?? 0);
}

export function CanvasListHeader({
  selectable = false,
  allSelected = false,
  someSelected = false,
  onSelectAll,
}: {
  selectable?: boolean;
  allSelected?: boolean;
  someSelected?: boolean;
  onSelectAll?: (next: boolean) => void;
} = {}) {
  return (
    <div
      className="hidden items-center gap-3 rounded-t-lg border-border border-b bg-surface-sunken px-4 py-2 text-xs font-medium text-muted lg:flex"
      // Not aria-hidden when it carries the interactive select-all control.
      aria-hidden={selectable ? undefined : true}
    >
      {selectable && (
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = someSelected;
          }}
          onChange={(event) => onSelectAll?.(event.target.checked)}
          aria-label="Select all canvases on this page"
          className="size-4 shrink-0 cursor-pointer accent-accent"
        />
      )}
      <span>Canvas</span>
    </div>
  );
}

export function DefaultRowActions({ canvas }: { canvas: CanvasListItem }) {
  const title = canvasTitle(canvas);
  if (!canvas.lastDeploy) {
    return (
      <Link
        to="/canvases/$id/editor"
        params={{ id: canvas.id }}
        className={rowPrimaryActionClass}
        aria-label={`Continue setup for ${title}`}
      >
        Continue setup
      </Link>
    );
  }
  return (
    <>
      <a
        href={canvas.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${title}`}
        className={rowPrimaryActionClass}
      >
        Open
        <ArrowSquareOut size={13} weight="bold" aria-hidden />
      </a>
      <CopyButton
        value={canvas.url}
        label="Copy link"
        ariaLabel={`Copy link for ${title}`}
        toastMessage="Link copied"
      />
    </>
  );
}

export function CanvasRow({
  canvas,
  actions,
  selectable = false,
  selected = false,
  onSelectChange,
}: {
  canvas: CanvasListItem;
  actions?: ReactNode;
  /** Opt-in bulk-selection mode: renders a leading checkbox (Your-canvases). */
  selectable?: boolean;
  selected?: boolean;
  onSelectChange?: (next: boolean) => void;
}) {
  const title = canvasTitle(canvas);
  const tags = canvasTags(canvas);
  const access = visibility(canvas);
  const deploy = canvas.lastDeploy;
  const navigate = useNavigate();
  const openDetails = () => navigate({ to: "/canvases/$id", params: { id: canvas.id } });

  // The four old data columns distilled to one quiet, dot-separated line — who can
  // see it, which version is live, and when it last changed. Lifecycle that isn't
  // the happy "published" path rides as a badge beside the title (RowBadges) instead.
  const meta = [
    access.primary,
    deploy && canvas.publicationState === "published" ? `v${deploy.version}` : null,
    `Edited ${relativeTime(lastActivity(canvas))}`,
  ].filter((part): part is string => Boolean(part));

  return (
    // Keyboard access to the canvas is the focusable title <Link> below (and the
    // inner Open/copy/menu controls). The whole-row click is a mouse convenience;
    // the <li> stays non-interactive (no role/tabIndex) because biome's a11y rules
    // disallow an interactive role on <li> and a tab stop here would only duplicate
    // the title link. onKeyDown is retained to satisfy useKeyWithClickEvents.
    <li
      className={`cursor-pointer rounded-xl border border-border bg-surface px-4 py-4 shadow-[var(--shadow-panel)] transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:border-border-strong hover:bg-surface-raised lg:rounded-none lg:border-0 lg:bg-transparent lg:shadow-none lg:hover:bg-surface-raised${
        selected ? " bg-accent-subtle lg:bg-accent-subtle" : ""
      }`}
      onClick={(event) => {
        if (isInteractiveTarget(event.target)) return;
        openDetails();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (isInteractiveTarget(event.target)) return;
        event.preventDefault();
        openDetails();
      }}
    >
      <div className="flex items-center gap-3 sm:gap-4">
        {selectable && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelectChange?.(event.target.checked)}
            aria-label={`Select ${title}`}
            className="size-4 shrink-0 cursor-pointer accent-accent"
          />
        )}
        {/* Hero thumbnail (plan 004 cover, enlarged): real preview when captured, else
            the deterministic generative art — decorative, the title is the affordance. */}
        <div className="aspect-[3/2] w-24 shrink-0 overflow-hidden rounded-md border border-border/60 sm:w-28">
          <CanvasCover
            seed={canvas.id}
            previewUrl={
              canvas.hasPreview
                ? `${previewCoverUrl(canvas.url, "thumb")}&v=${canvas.updatedAt}`
                : undefined
            }
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Link
              to="/canvases/$id"
              params={{ id: canvas.id }}
              className="min-w-0 truncate rounded-sm text-sm font-semibold text-fg underline-offset-2 outline-none transition-colors hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent/50"
              aria-label={`View details for ${title}`}
            >
              {title}
            </Link>
            <span className="flex shrink-0 flex-wrap items-center gap-1">
              <RowBadges canvas={canvas} />
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-subtle">{canvas.slug}</div>
          <div
            className="mt-0.5 truncate text-xs text-subtle"
            title={fullTime(lastActivity(canvas))}
          >
            {meta.join(" · ")}
          </div>
          {tags.length > 0 && (
            <div className="mt-1.5">
              <RowTags tags={tags} />
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {actions ?? <DefaultRowActions canvas={canvas} />}
        </div>
      </div>
    </li>
  );
}

export function ListSkeleton() {
  return (
    <ul className="space-y-2 lg:space-y-0 lg:divide-y lg:divide-border" aria-hidden>
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-4 sm:gap-4 lg:rounded-none lg:border-0 lg:bg-transparent"
        >
          <Skeleton className="aspect-[3/2] w-24 shrink-0 rounded-md sm:w-28" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-8 w-24 shrink-0" />
        </li>
      ))}
    </ul>
  );
}
