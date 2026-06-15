import { ArrowSquareOut, LockSimple } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { CanvasListItem, PublicationState } from "../lib/api.js";
import { formatBytes, relativeTime } from "../lib/format.js";
import { rowPrimaryActionClass } from "../lib/row-styles.js";
import { AccessBadge, Badge, PublicationBadge } from "./Badge.js";
import { CopyButton } from "./CopyButton.js";
import { Skeleton } from "./Skeleton.js";

const MAX_ROW_TAGS = 3;
const DESKTOP_GRID =
  "lg:grid-cols-[minmax(0,1.7fr)_minmax(0,0.85fr)_minmax(0,0.8fr)_minmax(0,0.95fr)_minmax(0,1.1fr)_10rem]";

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

function galleryState(canvas: CanvasListItem): { primary: string; secondary: string } {
  if (canvas.galleryTemplatable) {
    return { primary: "Template", secondary: "Reusable starter" };
  }
  if (canvas.galleryListed) {
    return { primary: "Listed", secondary: "In gallery" };
  }
  return { primary: "Unlisted", secondary: "Hidden from gallery" };
}

function publication(canvas: CanvasListItem): { primary: string; secondary: string } {
  const d = canvas.lastDeploy;
  if (canvas.publicationState === "published" && d) {
    const details = [relativeTime(d.createdAt)];
    if (d.totalBytes > 0 || d.fileCount > 0) {
      details.push(formatBytes(d.totalBytes));
      details.push(`${d.fileCount} ${d.fileCount === 1 ? "file" : "files"}`);
    }
    return { primary: `Published v${d.version}`, secondary: details.join(" - ") };
  }
  // Draft / Archived / Disabled (or the degenerate published-without-version) —
  // no version is currently served.
  const labels: Record<PublicationState, string> = {
    draft: "Draft",
    published: "Published",
    archived: "Archived",
    disabled: "Disabled",
    deleted: "Deleted",
  };
  return {
    primary: labels[canvas.publicationState],
    secondary: d ? `Last published v${d.version}` : "Not published",
  };
}

function DataCell({
  label,
  primary,
  secondary,
}: {
  label: string;
  primary: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="text-[0.6875rem] font-medium text-subtle lg:hidden">{label}</div>
      <div className="truncate text-sm font-medium text-fg">{primary}</div>
      {secondary && <div className="truncate text-xs text-subtle">{secondary}</div>}
    </div>
  );
}

export function CanvasListHeader() {
  return (
    <div
      className={`hidden gap-3 rounded-t-lg border-border border-b bg-surface-sunken px-4 py-2 text-xs font-medium text-muted lg:grid ${DESKTOP_GRID}`}
      aria-hidden
    >
      <span>Canvas</span>
      <span>Visibility</span>
      <span>Gallery</span>
      <span>Publication</span>
      <span>Tags</span>
      <span className="justify-self-end">Actions</span>
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

export function CanvasRow({ canvas, actions }: { canvas: CanvasListItem; actions?: ReactNode }) {
  const title = canvasTitle(canvas);
  const tags = canvasTags(canvas);
  const access = visibility(canvas);
  const pub = publication(canvas);
  const gallery = galleryState(canvas);
  const navigate = useNavigate();
  const openDetails = () => navigate({ to: "/canvases/$id", params: { id: canvas.id } });

  return (
    // Keyboard access to the canvas is the focusable title <Link> below (and the
    // inner Open/copy/menu controls). The whole-row click is a mouse convenience;
    // the <li> stays non-interactive (no role/tabIndex) because biome's a11y rules
    // disallow an interactive role on <li> and a tab stop here would only duplicate
    // the title link. onKeyDown is retained to satisfy useKeyWithClickEvents.
    <li
      className="cursor-pointer rounded-xl border border-border bg-surface px-4 py-3 shadow-[var(--shadow-panel)] transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:border-border-strong hover:bg-surface-raised lg:rounded-none lg:border-0 lg:bg-transparent lg:shadow-none lg:hover:bg-surface-raised"
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
      <div className={`grid gap-3 lg:items-center ${DESKTOP_GRID}`}>
        <div className="min-w-0">
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
          <div className="mt-1 truncate font-mono text-xs text-subtle">{canvas.slug}</div>
        </div>

        <DataCell label="Visibility" primary={access.primary} secondary={access.secondary} />
        <DataCell label="Gallery" primary={gallery.primary} secondary={gallery.secondary} />
        <DataCell label="Publication" primary={pub.primary} secondary={pub.secondary} />
        <DataCell label="Tags" primary={<RowTags tags={tags} />} />

        <div className="flex w-full items-center justify-end gap-1 border-t border-border/70 pt-3 lg:w-auto lg:border-t-0 lg:pt-0">
          {actions ?? <DefaultRowActions canvas={canvas} />}
        </div>
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
          className={`grid gap-3 rounded-xl border border-border bg-surface px-4 py-3 lg:items-center ${DESKTOP_GRID}`}
        >
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-20" />
        </li>
      ))}
    </ul>
  );
}
