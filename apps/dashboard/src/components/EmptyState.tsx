import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";

/** Deliberate empty/placeholder state (§6.9.8, §14.3). Copy is always specific —
 * never a generic "Nothing here yet" (anti-slop). */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-surface/70 px-6 py-14 text-center",
        className,
      )}
    >
      {icon && <div className="text-subtle">{icon}</div>}
      <div className="space-y-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        {description && <p className="mx-auto max-w-sm text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/* ── State-specific empty-state variants (UX sweep U7, brainstorm #2) ──────────
 *
 * One shared `EmptyState` component, but distinct, context-preserving copy + a
 * SINGLE targeted action per state. These factories own the copy and the action
 * LABEL (the load-bearing UX decision); consumers (the owner list in U9, the
 * gallery in U17) own the wiring — which filters are active, the clear handlers,
 * the router links — and pass it in. Each factory returns the props you spread
 * into `<EmptyState {...} />`, so a caller never re-types the copy:
 *
 *   <EmptyState {...searchEmptyState({ term, onClearSearch })} />
 *
 * The single-action constraint is enforced by the return shape: `action` is one
 * node. The specific-copy guard from this file's header still holds — every copy
 * string below is concrete; the assertions in the U7 tests reject generic strings.
 */

/** Render labels live here so copy stays authoritative in U7 and consumers can
 * neither drift them nor accidentally re-introduce a generic string. */
export const EMPTY_ACTION_LABELS = {
  archived: "View active canvases",
  search: "Clear search",
  filtered: "Clear all filters",
  galleryClearFilters: "Clear filters",
  galleryBrowseDocs: "Browse docs",
  firstRunCreate: "Create a canvas",
  firstRunDocs: "Read the docs",
} as const;

/** Forbidden generic phrasings — the anti-slop guard. Exported so the U7 tests
 * (and any future variant) can assert no variant copy contains them. Lowercased;
 * match case-insensitively. */
export const FORBIDDEN_EMPTY_COPY = [
  "nothing here yet",
  "nothing here",
  "no items",
  "no data",
  "no results", // too vague on its own — say WHAT and offer a way out
  "empty",
  "coming soon",
] as const;

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}

/** Owner-list archived scope with no archived canvases. Points back to the active
 * library rather than dead-ending. The action node (a router Link/Button) is built
 * by the consumer; we only fix its label. */
export function archivedEmptyState(opts: { action: ReactNode }): EmptyStateProps {
  return {
    title: "No archived canvases",
    description:
      "When you archive a canvas it lands here — offline but kept (files, settings, and its reserved URL) until you restore or delete it.",
    action: opts.action,
  };
}

/** Zero results because of an active search term. The single action CLEARS ONLY
 * the search term (`q`), preserving any other active filters — the consumer wires
 * `onClearSearch` to do exactly that (asserted at integration in U9). */
export function searchEmptyState(opts: {
  term?: string;
  onClearSearch: () => void;
}): EmptyStateProps {
  const quoted = opts.term?.trim() ? ` for “${opts.term.trim()}”` : "";
  return {
    title: `No canvases match your search${quoted}`,
    description:
      "Search looks across titles, summaries, tags, and slugs. Try fewer or different words, or clear the search to keep your other filters.",
    action: (
      <button
        type="button"
        onClick={opts.onClearSearch}
        className="text-sm font-medium text-accent transition-colors hover:text-accent-hover"
      >
        {EMPTY_ACTION_LABELS.search}
      </button>
    ),
  };
}

/** Zero results because of active NON-search filters (tags, status, etc.). The one
 * action clears all filters at once; the consumer wires `onClearFilters`. */
export function filteredEmptyState(opts: { onClearFilters: () => void }): EmptyStateProps {
  return {
    title: "No canvases match these filters",
    description: "Try loosening a filter, or clear them all to see your whole library.",
    action: (
      <button
        type="button"
        onClick={opts.onClearFilters}
        className="text-sm font-medium text-accent transition-colors hover:text-accent-hover"
      >
        {EMPTY_ACTION_LABELS.filtered}
      </button>
    ),
  };
}

/** Gallery with no results for the active filters/search. One primary action clears
 * the gallery filters; an optional docs link is offered as a secondary affordance
 * (the consumer passes the Link/anchor node). When the gallery is genuinely empty
 * (nothing shared yet), prefer a tailored consumer-side state instead. */
export function galleryEmptyState(opts: {
  onClearFilters: () => void;
  docsLink?: ReactNode;
}): EmptyStateProps {
  return {
    title: "No gallery canvases match your filters",
    description:
      "Nobody’s shared a canvas matching these yet. Clear the filters to browse everything in the gallery.",
    action: (
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={opts.onClearFilters}
          className="text-sm font-medium text-accent transition-colors hover:text-accent-hover"
        >
          {EMPTY_ACTION_LABELS.galleryClearFilters}
        </button>
        {opts.docsLink}
      </div>
    ),
  };
}

/** Truly no canvases (first run). One primary "Create a canvas" action plus a docs
 * pointer for orientation. Both nodes (router links) are built by the consumer so
 * the route targets stay out of this shared component. */
export function firstRunEmptyState(opts: {
  createAction: ReactNode;
  docsLink?: ReactNode;
}): EmptyStateProps {
  return {
    title: "Create your first canvas",
    description:
      "A canvas is a small web artifact you deploy and share with your org. Drop in some files to ship one in minutes.",
    action: (
      <div className="flex flex-wrap items-center justify-center gap-3">
        {opts.createAction}
        {opts.docsLink}
      </div>
    ),
  };
}
