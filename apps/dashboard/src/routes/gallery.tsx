import { LockSimple, MagnifyingGlass, X } from "@phosphor-icons/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { CopyButton } from "../components/CopyButton.js";
import { EmptyState } from "../components/EmptyState.js";
import { Skeleton } from "../components/Skeleton.js";
import { PageHeader } from "../components/Surface.js";
import { GALLERY_PAGE_SIZE, type GalleryItem } from "../lib/api.js";
import { useGallery } from "../lib/queries.js";
import type { GallerySearch } from "../router.js";

function GalleryCard({ item }: { item: GalleryItem }) {
  const navigate = useNavigate();
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-panel)]">
      <div className="flex items-start justify-between gap-2">
        {/* The title IS the open affordance — a direct external link to the live
            canvas. One primary target, no duplicate "Open" action. */}
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 truncate text-sm font-semibold text-fg hover:text-accent"
        >
          {item.title || "Untitled canvas"}
        </a>
        {item.hasPassword && (
          <Badge tone="neutral">
            <LockSimple size={12} weight="bold" aria-hidden />
            <span
              role="img"
              aria-label="Password required to open"
              title="Password required to open"
            >
              Protected
            </span>
          </Badge>
        )}
      </div>

      {item.summary && <p className="line-clamp-3 text-sm text-muted">{item.summary}</p>}

      {item.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() =>
                navigate({
                  to: "/gallery",
                  // Merge, not replace — keep any active search when filtering by tag.
                  search: (prev: GallerySearch) => ({ ...prev, tag, page: 1 }),
                })
              }
              className="rounded-md border border-border bg-surface-sunken px-2 py-0.5 text-xs font-medium text-muted transition-colors hover:text-fg"
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <div className="flex min-w-0 items-center gap-2">
          {item.owner.avatarUrl ? (
            <img
              src={item.owner.avatarUrl}
              alt=""
              className="size-5 shrink-0 rounded-full bg-surface-sunken"
            />
          ) : (
            <span className="size-5 shrink-0 rounded-full bg-surface-sunken" aria-hidden />
          )}
          <span className="truncate text-xs text-subtle">{item.owner.name}</span>
        </div>
        <CopyButton value={item.url} label="Copy link" toastMessage="Link copied" />
      </div>
    </li>
  );
}

function CardSkeletonGrid() {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => i).map((i) => (
        <li key={i} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="mt-2 h-4 w-1/3" />
        </li>
      ))}
    </ul>
  );
}

/** Opt-in gallery browse (§6.9 #11, M8). Lists canvases other members explicitly
 * shared AND opted into the gallery. Search + tag filter + pagination live in the
 * route's search params so views are shareable and back-button-able. */
export default function Gallery() {
  const search = useSearch({ strict: false }) as GallerySearch;
  const navigate = useNavigate();

  const q = search.q?.trim() || undefined;
  const tag = search.tag?.trim() || undefined;
  const page = Math.max(1, Math.floor(search.page ?? 1));
  const offset = (page - 1) * GALLERY_PAGE_SIZE;

  // Local mirror of the search box, debounced into the route param. Seeded on `q`
  // so a shared URL or back-nav populates the field.
  const [text, setText] = useState(q ?? "");
  useEffect(() => {
    setText(q ?? "");
  }, [q]);

  // Typing debounces (300ms); clearing the field applies immediately so the grid
  // doesn't stay filtered after the user emptied the box. Inlined (rather than a
  // shared setter) so the effect's only deps are the values it reads.
  useEffect(() => {
    const value = text.trim() || undefined;
    if (value === q) return; // already in sync — no navigation
    if (value === undefined) {
      navigate({
        to: "/gallery",
        search: (prev: GallerySearch) => ({ ...prev, q: undefined, page: 1 }),
      });
      return;
    }
    const id = setTimeout(() => {
      navigate({
        to: "/gallery",
        search: (prev: GallerySearch) => ({ ...prev, q: value, page: 1 }),
      });
    }, 300);
    return () => clearTimeout(id);
  }, [text, q, navigate]);

  const { data, isLoading, isError, isPlaceholderData, refetch } = useGallery({
    q,
    tag,
    limit: GALLERY_PAGE_SIZE,
    offset,
  });

  // A fresh refetch that drops below the current page (e.g. an item was un-listed
  // while on the last page) snaps back to page 1 rather than showing an empty page.
  // Gated on !isPlaceholderData so a stale keepPreviousData total from the prior
  // query can't trigger a spurious reset mid-navigation.
  useEffect(() => {
    if (!isPlaceholderData && data && data.total > 0 && offset >= data.total) {
      navigate({ to: "/gallery", search: (prev: GallerySearch) => ({ ...prev, page: 1 }) });
    }
  }, [data, isPlaceholderData, offset, navigate]);

  function clearTag() {
    navigate({
      to: "/gallery",
      search: (prev: GallerySearch) => ({ ...prev, tag: undefined, page: 1 }),
    });
  }

  function clearFilters() {
    setText("");
    navigate({ to: "/gallery", search: {} });
  }

  function goToPage(next: number) {
    navigate({ to: "/gallery", search: (prev: GallerySearch) => ({ ...prev, page: next }) });
  }

  const total = data?.total ?? 0;
  const items = data?.items ?? [];
  const from = total === 0 ? 0 : offset + 1;
  // Clamp to `total` so a stale-data render (keepPreviousData) can't briefly show
  // "Showing 49–49 of 5" before the page snaps back.
  const to = Math.min(offset + items.length, total);
  const hasPrev = page > 1;
  const hasNext = offset + items.length < total;
  const filtering = Boolean(q || tag);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Gallery"
        description="Canvases your colleagues have shared and listed. Open one, or copy its link."
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[14rem]">
          <MagnifyingGlass
            size={16}
            className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 text-subtle"
            aria-hidden
          />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search the gallery"
            aria-label="Search the gallery"
            className="h-9 w-full rounded-lg border border-border bg-surface pr-3 pl-9 text-sm text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
          />
        </div>
        {tag && (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-sunken py-1 pr-1 pl-2.5 text-xs font-medium text-muted">
            #{tag}
            <button
              type="button"
              onClick={clearTag}
              aria-label="Remove tag filter"
              className="grid size-5 place-items-center rounded text-subtle transition-colors hover:text-fg"
            >
              <X size={12} weight="bold" aria-hidden />
            </button>
          </span>
        )}
      </div>

      {isLoading && <CardSkeletonGrid />}

      {isError && (
        <EmptyState
          title="Couldn't load the gallery"
          description="Something went wrong fetching listed canvases."
          action={
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          }
        />
      )}

      {data && items.length === 0 && !filtering && (
        <EmptyState
          title="No canvases in the gallery yet"
          description="When a colleague shares a canvas and flips “List in the gallery” in its settings, it shows up here."
          action={
            <Link to="/" className="text-sm font-medium text-accent">
              Back to your canvases
            </Link>
          }
        />
      )}

      {data && items.length === 0 && filtering && (
        <EmptyState
          title="No canvases match your search"
          description="Try a different term, or clear the filters to see everything in the gallery."
          action={
            <Button variant="secondary" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      )}

      {items.length > 0 && (
        <>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <GalleryCard key={item.id} item={item} />
            ))}
          </ul>

          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="text-xs text-subtle">
              Showing {from}–{to} of {total}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={!hasPrev}
                onClick={() => goToPage(page - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!hasNext}
                onClick={() => goToPage(page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export { GalleryCard };
