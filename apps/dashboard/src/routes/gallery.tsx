import { ArrowSquareOut, Copy, X } from "@phosphor-icons/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ActionMenu, ActionMenuItem } from "../components/ActionMenu.js";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { CanvasCover, previewCoverUrl } from "../components/CanvasCover.js";
import { CloneDialog } from "../components/CloneDialog.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterChip, FilterSelect } from "../components/Filters.js";
import { SearchInput } from "../components/SearchInput.js";
import { Skeleton } from "../components/Skeleton.js";
import { PageHeader } from "../components/Surface.js";
import { Tag } from "../components/Tag.js";
import { GALLERY_PAGE_SIZE, type GalleryItem } from "../lib/api.js";
import { useClipboardCopy } from "../lib/clipboard.js";
import { useGallery, useGalleryFacets } from "../lib/queries.js";
import { cardHoverClass } from "../lib/row-styles.js";
import { useDebouncedUrlSearch } from "../lib/use-debounced-url-search.js";
import { usePagination } from "../lib/use-pagination.js";
import type { GallerySearch } from "../router.js";

function GalleryCard({ item }: { item: GalleryItem }) {
  const navigate = useNavigate();
  const copy = useClipboardCopy();
  const [cloneOpen, setCloneOpen] = useState(false);
  return (
    <li
      className={`group relative flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-panel)] ${cardHoverClass}`}
    >
      {/* Generative cover hero in a fixed aspect-ratio region (plan 004). A real
          screenshot will later render into this same box with no layout change.
          Decorative (not a link) so the title below stays the single open
          affordance — no duplicate link for screen readers. */}
      <div className="aspect-[3/2] w-full overflow-hidden">
        <CanvasCover
          seed={item.id}
          previewUrl={item.hasPreview ? previewCoverUrl(item.url) : undefined}
        />
      </div>
      <div className="flex flex-1 flex-col gap-2.5 p-3.5">
        <div className="flex items-start justify-between gap-2">
          {/* The title IS the open affordance — a direct external link to the live
            canvas. Its ::after stretches over the whole card so clicking anywhere
            (except the raised tag/action controls below) opens the canvas, while
            screen readers still get one labelled link. */}
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate font-serif text-[0.95rem] font-medium text-fg after:absolute after:inset-0 after:rounded-xl after:content-[''] hover:text-accent"
          >
            {item.title || "Untitled canvas"}
          </a>
          {item.templatable && <Badge tone="accent">Template</Badge>}
        </div>

        {item.summary && <p className="line-clamp-2 text-sm text-muted">{item.summary}</p>}

        {item.tags.length > 0 && (
          <div className="relative z-10 flex flex-wrap gap-1.5">
            {item.tags.map((tag) => (
              <Tag
                key={tag}
                size="sm"
                onClick={() =>
                  navigate({
                    to: "/gallery",
                    // Merge, not replace — keep any active search when filtering by tag.
                    search: (prev: GallerySearch) => ({ ...prev, tag, page: 1 }),
                  })
                }
              >
                {tag}
              </Tag>
            ))}
          </div>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <div className="flex min-w-0 items-center gap-2">
            {item.owner.avatarUrl ? (
              <img
                src={item.owner.avatarUrl}
                alt=""
                referrerPolicy="no-referrer"
                className="size-5 shrink-0 rounded-full bg-surface-sunken"
              />
            ) : (
              <span className="size-5 shrink-0 rounded-full bg-surface-sunken" aria-hidden />
            )}
            <span className="truncate text-xs text-subtle">{item.owner.name}</span>
          </div>
          {/* Raised above the title's stretched ::after so these stay clickable
              while the rest of the card opens the canvas. Templatable cards keep a
              visible "Make a copy" primary; the kebab carries the rest. */}
          <div className="relative z-10 flex shrink-0 items-center gap-1">
            {item.templatable && (
              <Button size="sm" variant="secondary" onClick={() => setCloneOpen(true)}>
                Duplicate
                <Copy size={14} weight="bold" aria-hidden />
              </Button>
            )}
            <ActionMenu label={`More actions for ${item.title || "this canvas"}`}>
              <ActionMenuItem
                href={item.url}
                target="_blank"
                rel="noreferrer"
                icon={<ArrowSquareOut size={15} aria-hidden />}
              >
                Open in new tab
              </ActionMenuItem>
              <ActionMenuItem
                icon={<Copy size={15} aria-hidden />}
                onSelect={() => copy(item.url, "Link copied")}
              >
                Copy link
              </ActionMenuItem>
            </ActionMenu>
          </div>
        </div>
        {item.templatable && (
          <CloneDialog
            open={cloneOpen}
            onClose={() => setCloneOpen(false)}
            sourceId={item.id}
            sourceTitle={item.title}
          />
        )}
      </div>
    </li>
  );
}

function CardSkeletonGrid() {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => i).map((i) => (
        <li
          key={i}
          className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface"
        >
          <Skeleton className="aspect-[3/2] w-full rounded-none" />
          <div className="flex flex-col gap-2.5 p-3.5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="mt-2 h-4 w-1/3" />
          </div>
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
  const owner = search.owner?.trim() || undefined;
  const templatable = search.templatable === true;
  const sort = search.sort ?? "published";
  const page = Math.max(1, Math.floor(search.page ?? 1));
  const offset = (page - 1) * GALLERY_PAGE_SIZE;

  // Search box ⇆ URL `q`, debounced (shared with the Your-canvases/admin lists).
  const [text, setText] = useDebouncedUrlSearch(q, "/gallery");

  const { data, isLoading, isError, isPlaceholderData, refetch } = useGallery({
    q,
    tag,
    owner,
    templatable,
    sort,
    limit: GALLERY_PAGE_SIZE,
    offset,
  });
  const facets = useGalleryFacets();

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
  const { from, to, hasPrev, hasNext } = usePagination({
    total,
    offset,
    itemCount: items.length,
    page,
  });
  const filtering = Boolean(q || tag || owner || templatable);

  function setOwner(next: string) {
    navigate({
      to: "/gallery",
      search: (prev: GallerySearch) => ({ ...prev, owner: next || undefined, page: 1 }),
    });
  }
  function toggleTemplatable() {
    navigate({
      to: "/gallery",
      search: (prev: GallerySearch) => ({
        ...prev,
        templatable: templatable ? undefined : true,
        page: 1,
      }),
    });
  }
  function setSort(next: string) {
    navigate({
      to: "/gallery",
      search: (prev: GallerySearch) => ({
        ...prev,
        sort: next === "published" ? undefined : (next as GallerySearch["sort"]),
        page: 1,
      }),
    });
  }

  const ownerOptions = [{ value: "", label: "All owners" }];
  for (const o of facets.data?.owners ?? []) ownerOptions.push({ value: o.id, label: o.name });
  // A deep-linked owner with no currently-visible canvas won't be in the facet
  // list — keep the select controlled by surfacing it as a fallback option.
  if (owner && !ownerOptions.some((o) => o.value === owner)) {
    ownerOptions.push({ value: owner, label: "Selected owner" });
  }
  const sortOptions = [
    { value: "published", label: "Newest" },
    { value: "updated", label: "Recently updated" },
    { value: "title", label: "Title A–Z" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Gallery"
        description="Canvases your colleagues have shared and listed. Open one, or copy its link."
      />

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={text}
          onChange={setText}
          placeholder="Search the gallery"
          aria-label="Search the gallery"
        />
        <FilterSelect
          label="Sort canvases"
          options={sortOptions}
          value={sort}
          onValueChange={setSort}
        />
      </div>

      <FilterBar>
        <FilterSelect
          label="Filter by owner"
          options={ownerOptions}
          value={owner ?? ""}
          onValueChange={setOwner}
          // Until facets resolve the only option is "All owners"; disable so a user
          // can't open an incomplete list and think there are no other owners.
          disabled={facets.isLoading && ownerOptions.length <= 1}
        />
        <FilterChip active={templatable} onClick={toggleTemplatable}>
          Templates
        </FilterChip>
        {tag && (
          <span className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface-sunken pr-1 pl-2.5 text-xs font-medium text-muted">
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
        {filtering && (
          <button
            type="button"
            onClick={clearFilters}
            className="h-9 px-2 text-xs font-medium text-subtle transition-colors hover:text-fg"
          >
            Clear all
          </button>
        )}
      </FilterBar>

      {isLoading && <CardSkeletonGrid />}

      {isError && (
        <EmptyState
          title="Couldn't load the gallery"
          description="We couldn't reach the gallery just now. Try again."
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
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
