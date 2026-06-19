import { ArrowSquareOut, LockSimple } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { CanvasListItem } from "../lib/api.js";
import { formatBytes, fullTime, relativeTime } from "../lib/format.js";
import { rowPrimaryActionClass } from "../lib/row-styles.js";
import { AccessBadge, accessRungLabel, ConceptBadge, PublicationBadge } from "./Badge.js";
import { previewCoverUrl } from "./CanvasCover.js";
import { CanvasGridCard, cardNameLinkClass } from "./CanvasGridCard.js";
import { CanvasListRow } from "./CanvasListRow.js";
import { CopyButton } from "./CopyButton.js";
import { coverType } from "./GenerativeCover.js";
import { Skeleton } from "./Skeleton.js";
import { Tag } from "./Tag.js";

const MAX_ROW_TAGS = 3;

/** Display title: the trimmed title, or the slug as a stable fallback. Shared so
 * the Your-canvases route renders identical titles to the list rows. */
export function canvasTitle(canvas: CanvasListItem): string {
  return canvas.title?.trim() || canvas.slug;
}

function canvasTags(canvas: CanvasListItem): string[] {
  return Array.isArray(canvas.tags)
    ? canvas.tags.filter((t): t is string => typeof t === "string")
    : [];
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
      {canvas.galleryTemplatable && <ConceptBadge concept="templates">Template</ConceptBadge>}
      {/* Listed-but-not-template: gallery state used to be its own column. */}
      {canvas.galleryListed && !canvas.galleryTemplatable && (
        <ConceptBadge concept="listed">Listed</ConceptBadge>
      )}
      {canvas.hasPassword && (
        <ConceptBadge concept="protected">
          <LockSimple size={12} weight="bold" aria-hidden />
          Protected
        </ConceptBadge>
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
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((tag) => (
        <Tag key={tag} size="xs">
          {tag}
        </Tag>
      ))}
      {extra > 0 && (
        <Tag size="xs" tone="subtle" title={`${extra} more tags`}>
          +{extra}
        </Tag>
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
 *  bump `updatedAt`) and its last publish. Drives the "Edited …" row hint. Exported
 *  so the detail rail (DetailPanel) shares the exact same recency logic. */
export function lastActivity(canvas: CanvasListItem): number {
  return Math.max(canvas.updatedAt, canvas.lastDeploy?.createdAt ?? 0);
}

/** Short visibility line — leads with the access rung and flags a password gate.
 *  Exported (canonical) so the detail rail renders the same label as the list and
 *  the two never drift. */
export function visibilityLabel(canvas: CanvasListItem): string {
  const base = accessRungLabel(canvas.access);
  return canvas.hasPassword ? `${base} · Protected` : base;
}

/** Quiet, dot-separated identity line — who can see it and when it last changed.
 *  Shared by the list row and the grid card so the two views never drift. */
function metaLine(canvas: CanvasListItem): string {
  return [visibility(canvas).primary, `Edited ${relativeTime(lastActivity(canvas))}`].join(" · ");
}

/** The deployed footprint, e.g. "12 kB · 4 files", or null when never deployed. */
function deployFootprint(canvas: CanvasListItem): string | null {
  const d = canvas.lastDeploy;
  if (!d) return null;
  return `${formatBytes(d.totalBytes)} · ${d.fileCount} ${d.fileCount === 1 ? "file" : "files"}`;
}

/** Popularity summary (plan 004), shared by the row + card so the two never drift.
 *  `recentViews` is the trending 30-day count the "Most popular" sort ranks by; the
 *  tooltip adds the all-time total. `lastViewed` is a relative "Viewed Nd ago" line,
 *  or null when the canvas has never been viewed. */
function viewsSummary(canvas: CanvasListItem): {
  count: number;
  lastViewed: string | null;
  title: string;
} {
  const lastViewed = canvas.lastViewedAt ? `Viewed ${relativeTime(canvas.lastViewedAt)}` : null;
  const allTime = `${canvas.viewCount} all-time ${canvas.viewCount === 1 ? "view" : "views"}`;
  return {
    count: canvas.recentViews,
    lastViewed,
    title: `${canvas.recentViews} in the last 30 days · ${allTime}`,
  };
}

/** A right-aligned secondary stat (Published / Created) that fills the list row's
 *  wide-screen gutter without re-introducing the old dense column grid. */
function StatCol({
  label,
  primary,
  secondary,
  title,
}: {
  label: string;
  primary: string;
  secondary?: string | null;
  title?: string;
}) {
  return (
    <div className="w-32 text-right" title={title}>
      <div className="text-[0.6875rem] font-medium text-subtle">{label}</div>
      <div className="mt-0.5 truncate text-xs font-medium text-fg">{primary}</div>
      {secondary && <div className="truncate text-[0.6875rem] text-subtle">{secondary}</div>}
    </div>
  );
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
    // Flat Lovable-style header: a quiet column label on the plain page background
    // with just a hairline divider underneath — no filled sunken bar, no card.
    <div
      className="hidden items-center gap-3 border-border border-b px-4 py-2 text-xs font-medium text-muted lg:flex"
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
  /** The row's "Details" action (opening the inline detail rail) is wired by the
   *  caller directly to the Details button in the `actions` slot — the body click no
   *  longer routes through this component, so there is no `onActivate` body handler. */
}) {
  const title = canvasTitle(canvas);
  const tags = canvasTags(canvas);
  const deploy = canvas.lastDeploy;
  // The canvas's unified description (the field the overview edits, also shown in the
  // gallery — U21) so the line on the row matches what populates when you open it.
  const footprint = deployFootprint(canvas);
  const views = viewsSummary(canvas);
  const navigate = useNavigate();
  // The whole-row body click (and keyboard Enter/Space) opens the canvas's detail /
  // management page (`/canvases/$id` — Overview/Editor/Share/…). This is independent
  // of `onActivate`, which the explicit "Details" button uses to open the inline rail.
  const openDetail = () => navigate({ to: "/canvases/$id", params: { id: canvas.id } });

  return (
    <CanvasListRow
      seed={canvas.id}
      previewUrl={
        canvas.hasPreview
          ? `${previewCoverUrl(canvas.url, "thumb")}&v=${canvas.updatedAt}`
          : undefined
      }
      selected={selected}
      onActivate={openDetail}
      nameLink={
        <Link
          to="/canvases/$id"
          params={{ id: canvas.id }}
          className="min-w-0 truncate rounded-sm font-serif text-[0.95rem] font-medium text-fg underline-offset-2 outline-none transition-colors hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent/50"
          aria-label={`View details for ${title}`}
        >
          {title}
        </Link>
      }
      badges={<RowBadges canvas={canvas} />}
      meta={
        <>
          <span className="block truncate font-mono text-subtle">{canvas.slug}</span>
          <span className="mt-0.5 block truncate" title={fullTime(lastActivity(canvas))}>
            {metaLine(canvas)}
          </span>
        </>
      }
      description={canvas.description}
      tags={tags.length > 0 ? <RowTags tags={tags} /> : undefined}
      leading={
        selectable ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelectChange?.(event.target.checked)}
            aria-label={`Select ${title}`}
            className="size-4 shrink-0 cursor-pointer accent-accent"
          />
        ) : undefined
      }
      stats={
        <>
          <StatCol
            label={deploy ? "Published" : "Status"}
            primary={deploy ? `v${deploy.version}` : "Not deployed"}
            secondary={footprint}
          />
          <StatCol
            label="Views"
            primary={`${views.count}`}
            secondary={views.lastViewed}
            title={views.title}
          />
          <StatCol
            label="Created"
            primary={relativeTime(canvas.createdAt)}
            title={fullTime(canvas.createdAt)}
          />
        </>
      }
      actions={actions ?? <DefaultRowActions canvas={canvas} />}
    />
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

/** Grid card — the cover-fills-card presentation behind the list/grid toggle, built
 *  on the shared {@link CanvasGridCard} so the owner grid and the public gallery read
 *  the same. Same data + same `actions` slot as {@link CanvasRow}; the cover fills the
 *  whole tile and the name/status/tags/description overlay it on a persistent scrim,
 *  with the actions in a raised top-right cluster. The ONLY owner-vs-gallery
 *  difference is which slots get filled (here: lifecycle actions + bulk-select). */
export function CanvasCard({
  canvas,
  actions,
  selectable = false,
  selected = false,
  onSelectChange,
}: {
  canvas: CanvasListItem;
  actions?: ReactNode;
  selectable?: boolean;
  selected?: boolean;
  onSelectChange?: (next: boolean) => void;
  /** See {@link CanvasRow}: the card body click navigates to the canvas detail page;
   *  the "Details" action (inline rail) is wired by the caller to the Details button
   *  in the `actions` slot, not to the body. */
}) {
  const title = canvasTitle(canvas);
  const navigate = useNavigate();
  // Body click / Enter navigates to the canvas detail page (`/canvases/$id`); the
  // "Details" button in the actions slot opens the inline rail instead.
  const openDetail = () => navigate({ to: "/canvases/$id", params: { id: canvas.id } });

  return (
    <CanvasGridCard
      seed={canvas.id}
      title={title}
      previewUrl={
        canvas.hasPreview
          ? `${previewCoverUrl(canvas.url, "card")}&v=${canvas.updatedAt}`
          : undefined
      }
      coverType={coverType({
        templatable: canvas.galleryTemplatable,
        listed: canvas.galleryListed,
        protectedByPassword: canvas.hasPassword,
      })}
      status={canvas.publicationState}
      selected={selected}
      onActivate={openDetail}
      nameLink={
        <Link
          to="/canvases/$id"
          params={{ id: canvas.id }}
          className={cardNameLinkClass}
          aria-label={`View details for ${title}`}
        >
          {title}
        </Link>
      }
      badges={
        <>
          <PublicationBadge state={canvas.publicationState} />
          {canvas.access === "public_link" && <AccessBadge access="public_link" />}
          {canvas.galleryTemplatable && <ConceptBadge concept="templates">Template</ConceptBadge>}
          {canvas.hasPassword && (
            <ConceptBadge concept="protected">
              <LockSimple size={12} weight="bold" aria-hidden />
              Protected
            </ConceptBadge>
          )}
        </>
      }
      tags={canvasTags(canvas)}
      description={canvas.description}
      topLeft={
        selectable ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelectChange?.(event.target.checked)}
            aria-label={`Select ${title}`}
            className="size-4 cursor-pointer rounded accent-accent shadow-[var(--shadow-sm)]"
          />
        ) : undefined
      }
      actions={actions ?? <DefaultRowActions canvas={canvas} />}
    />
  );
}

export function GridSkeleton() {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="overflow-hidden rounded-xl border border-border bg-surface">
          <Skeleton className="aspect-[3/2] w-full rounded-none" />
          <div className="space-y-2 p-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-8 w-full" />
          </div>
        </li>
      ))}
    </ul>
  );
}
