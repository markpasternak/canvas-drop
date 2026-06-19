import { ArrowSquareOut, Copy, Rows, SquaresFour, X } from "@phosphor-icons/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ActionMenu, ActionMenuItem } from "../components/ActionMenu.js";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { previewCoverUrl } from "../components/CanvasCover.js";
import { CanvasGridCard, cardNameLinkClass } from "../components/CanvasGridCard.js";
import { CanvasListRow } from "../components/CanvasListRow.js";
import { CloneDialog } from "../components/CloneDialog.js";
import { EmptyState, galleryEmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterChip, FilterSelect } from "../components/Filters.js";
import { coverType } from "../components/GenerativeCover.js";
import { SearchInput } from "../components/SearchInput.js";
import { SegmentedControl } from "../components/SegmentedControl.js";
import { Skeleton } from "../components/Skeleton.js";
import { PageHeader } from "../components/Surface.js";
import { Tag } from "../components/Tag.js";
import { GALLERY_PAGE_SIZE, type GalleryItem } from "../lib/api.js";
import { useClipboardCopy } from "../lib/clipboard.js";
import { type GalleryView, persistGalleryView, resolveGalleryView } from "../lib/gallery-view.js";
import { useGallery, useGalleryFacets } from "../lib/queries.js";
import { useDebouncedUrlSearch } from "../lib/use-debounced-url-search.js";
import { usePagination } from "../lib/use-pagination.js";
import type { GallerySearch } from "../router.js";

const galleryTitle = (item: GalleryItem) => item.title || "Untitled canvas";

/** Open the live canvas in a new tab — the gallery's whole-card/row navigation. */
function openLive(item: GalleryItem) {
  window.open(item.url, "_blank", "noopener,noreferrer");
}

/** The template ("Use template") + overflow cluster — the ONLY owner-vs-gallery
 *  differentiator. Shared by the gallery grid card and list row so they match. */
function GalleryActions({
  item,
  onClone,
  copy,
}: {
  item: GalleryItem;
  onClone: () => void;
  copy: (value: string, message: string) => void;
}) {
  return (
    <>
      {item.templatable && (
        <Button size="sm" variant="secondary" onClick={onClone}>
          Use template
          <Copy size={14} weight="bold" aria-hidden />
        </Button>
      )}
      <ActionMenu label={`More actions for ${galleryTitle(item)}`}>
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
    </>
  );
}

/** The owner avatar + name strip — the gallery-only footer that surfaces who shared
 *  the canvas (the owner cards surface lifecycle actions instead). */
function OwnerStrip({ item }: { item: GalleryItem }) {
  return (
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
      <span className="truncate text-xs text-white/85">{item.owner.name}</span>
    </div>
  );
}

/** Clickable tag-filter pills for the list row (merge with any active search). */
function GalleryRowTags({ item, onTag }: { item: GalleryItem; onTag: (tag: string) => void }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {item.tags.map((tag) => (
        <Tag key={tag} size="xs" onClick={() => onTag(tag)}>
          {tag}
        </Tag>
      ))}
    </span>
  );
}

/** Gallery grid card — the SAME shared {@link CanvasGridCard} the owner grid uses.
 *  Only the slots differ: a Template/Use-template action + owner footer (vs the
 *  owner card's lifecycle actions + bulk-select). */
function GalleryCard({ item }: { item: GalleryItem }) {
  const navigate = useNavigate();
  const copy = useClipboardCopy();
  const [cloneOpen, setCloneOpen] = useState(false);
  const onTag = (tag: string) =>
    navigate({ to: "/gallery", search: (prev: GallerySearch) => ({ ...prev, tag, page: 1 }) });

  return (
    <>
      <CanvasGridCard
        seed={item.id}
        title={galleryTitle(item)}
        // Gallery items are always listed + published; a templatable one reads as a Template.
        coverType={coverType({ templatable: item.templatable, listed: true })}
        status="published"
        previewUrl={item.hasPreview ? previewCoverUrl(item.url) : undefined}
        onActivate={() => openLive(item)}
        nameLink={
          <a href={item.url} target="_blank" rel="noreferrer" className={cardNameLinkClass}>
            {galleryTitle(item)}
          </a>
        }
        badges={item.templatable ? <Badge tone="accent">Template</Badge> : undefined}
        tags={item.tags}
        onTagClick={onTag}
        description={item.description}
        footer={<OwnerStrip item={item} />}
        actions={<GalleryActions item={item} onClone={() => setCloneOpen(true)} copy={copy} />}
      />
      {item.templatable && (
        <CloneDialog
          open={cloneOpen}
          onClose={() => setCloneOpen(false)}
          sourceId={item.id}
          sourceTitle={item.title}
        />
      )}
    </>
  );
}

/** Gallery list row — the SAME shared {@link CanvasListRow} the owner list uses.
 *  Only the slots differ: a Template badge + Use-template action + owner meta. */
function GalleryRow({ item }: { item: GalleryItem }) {
  const navigate = useNavigate();
  const copy = useClipboardCopy();
  const [cloneOpen, setCloneOpen] = useState(false);
  const onTag = (tag: string) =>
    navigate({ to: "/gallery", search: (prev: GallerySearch) => ({ ...prev, tag, page: 1 }) });

  return (
    <>
      <CanvasListRow
        seed={item.id}
        previewUrl={item.hasPreview ? previewCoverUrl(item.url, "thumb") : undefined}
        coverType={coverType({ templatable: item.templatable, listed: true })}
        onActivate={() => openLive(item)}
        nameLink={
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate rounded-sm font-serif text-[0.95rem] font-medium text-fg underline-offset-2 outline-none transition-colors hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            {galleryTitle(item)}
          </a>
        }
        badges={item.templatable ? <Badge tone="accent">Template</Badge> : undefined}
        meta={<span className="truncate">by {item.owner.name}</span>}
        description={item.description}
        tags={item.tags.length > 0 ? <GalleryRowTags item={item} onTag={onTag} /> : undefined}
        actions={<GalleryActions item={item} onClone={() => setCloneOpen(true)} copy={copy} />}
      />
      {item.templatable && (
        <CloneDialog
          open={cloneOpen}
          onClose={() => setCloneOpen(false)}
          sourceId={item.id}
          sourceTitle={item.title}
        />
      )}
    </>
  );
}

/** Grid ⇄ list layout switch for the gallery — mirrors the owner list's ViewToggle
 *  (U8) so the two surfaces behave identically. */
function GalleryViewToggle({
  value,
  onChange,
}: {
  value: GalleryView;
  onChange: (v: GalleryView) => void;
}) {
  return (
    <SegmentedControl
      aria-label="Gallery layout"
      iconOnly
      value={value}
      onChange={onChange}
      items={[
        { value: "list", label: "List view", icon: Rows },
        { value: "grid", label: "Grid view", icon: SquaresFour },
      ]}
    />
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

/** Cap for the admin-curated Featured row (U17). Beyond 6 is silently dropped; the
 *  "see all featured" overflow view is the deferred follow-up. */
const FEATURED_CAP = 6;
/** How many of the most-recently-published canvases the discovery strip surfaces. */
const RECENT_CAP = 6;
/** How many top-tag shortcut chips to surface above the grid. */
const TOP_TAG_CAP = 8;

/** A horizontal discovery strip (Featured / Recently published) above the main
 *  paginated grid. A heading + a row of the SAME unified gallery cards, wrapping on
 *  wider viewports and scrolling-free on narrow ones. Renders nothing when empty so a
 *  barren gallery never shows a hollow heading. */
function DiscoveryStrip({
  heading,
  description,
  items,
}: {
  heading: string;
  description?: string;
  items: GalleryItem[];
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={heading} className="space-y-3">
      <div className="space-y-0.5">
        <h2 className="font-serif text-sm font-medium text-fg">{heading}</h2>
        {description && <p className="text-xs text-subtle">{description}</p>}
      </div>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items.map((item) => (
          <GalleryCard key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

/** Top-tag shortcut chips: the most common gallery tags as one-click `?tag=` filters,
 *  complementing the richer multi-select control. Sourced from the gallery facets
 *  (the authoritative distinct-tag list across all currently-visible canvases) so the
 *  chips reflect the whole gallery, not just the loaded page. Hidden when no tags
 *  exist or all top tags are already active. */
function TopTagChips({
  tags,
  active,
  onToggle,
}: {
  tags: string[];
  active: string;
  onToggle: (tag: string) => void;
}) {
  const top = tags.slice(0, TOP_TAG_CAP);
  if (top.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-subtle">Popular tags</span>
      {top.map((tag) => (
        <Tag
          key={tag}
          size="sm"
          className={active === tag ? "border-accent/40 text-accent" : undefined}
          onClick={() => onToggle(tag)}
        >
          #{tag}
        </Tag>
      ))}
    </div>
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
  // View-mode precedence mirrors the owner list (U8): URL `?view=` > localStorage >
  // default("grid"). Read synchronously in render so the layout paints right first.
  const view: GalleryView = resolveGalleryView(search.view);
  const page = Math.max(1, Math.floor(search.page ?? 1));
  const offset = (page - 1) * GALLERY_PAGE_SIZE;

  // Search box ⇆ URL `q`, debounced (shared with the Your-canvases/admin lists).
  const [text, setText] = useDebouncedUrlSearch(q, "/gallery");

  const { data, isLoading, isError, isPlaceholderData, refetch } = useGallery({
    q,
    // The query surface is multi-tag any-match (U3); the single-tag URL param maps to a
    // one-element array. The multi-select TagFilter UI lands in a later unit.
    tag: tag ? [tag] : undefined,
    owner,
    templatable,
    sort,
    limit: GALLERY_PAGE_SIZE,
    offset,
  });
  const facets = useGalleryFacets();

  // Discovery rows above the main grid (U17). They are a curated/recency *slice* of
  // the gallery — distinct from the paginated grid and its sort — so they're only a
  // scanning aid on the default, unfiltered, grid view. Suppressed while filtering or
  // in list mode so they never duplicate or fight the focused result set.
  const showDiscovery = view === "grid" && !q && !tag && !owner && !templatable;
  const featuredQuery = useGallery({
    featured: true,
    sort: "featured",
    limit: FEATURED_CAP,
    offset: 0,
  });
  const recentQuery = useGallery({ sort: "recent", limit: RECENT_CAP, offset: 0 });
  // Admin-curation can leave a stale-true flag on a now-unlisted canvas; the gallery
  // visibility predicate already filters those at query time, so the row only ever
  // carries live+listed+published+featured items. Cap defensively in case the server
  // returns more than the requested limit.
  const featuredItems = (featuredQuery.data?.items ?? []).slice(0, FEATURED_CAP);
  const recentItems = (recentQuery.data?.items ?? []).slice(0, RECENT_CAP);

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
  function setView(next: GalleryView) {
    // Persist the per-device choice and reflect it in `?view=` for this visit
    // (shareable). Layout is a pure view concern — preserve filters/sort/page.
    persistGalleryView(next);
    navigate({ to: "/gallery", search: (prev: GallerySearch) => ({ ...prev, view: next }) });
  }

  const ownerOptions = [{ value: "", label: "All owners" }];
  for (const o of facets.data?.owners ?? []) ownerOptions.push({ value: o.id, label: o.name });
  // A deep-linked owner with no currently-visible canvas won't be in the facet
  // list — keep the select controlled by surfacing it as a fallback option.
  if (owner && !ownerOptions.some((o) => o.value === owner)) {
    ownerOptions.push({ value: owner, label: "Selected owner" });
  }
  // Featured / Trending / Recent / Title (U17), wired to the backend `?sort=` axes.
  // `published` is the default ("recent" is its alias) so omitting it keeps a bare URL.
  const sortOptions = [
    { value: "featured", label: "Featured" },
    { value: "trending", label: "Trending" },
    { value: "published", label: "Recent" },
    { value: "title", label: "Title A–Z" },
  ];

  /** One-click top-tag chip: toggles a single `?tag=` filter (replacing any current
   *  single tag), resetting to page 1. Mirrors the card tag-click contract. */
  function toggleTopTag(next: string) {
    navigate({
      to: "/gallery",
      search: (prev: GallerySearch) => ({
        ...prev,
        tag: prev.tag === next ? undefined : next,
        page: 1,
      }),
    });
  }

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
        <GalleryViewToggle value={view} onChange={setView} />
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

      {/* Top-tag shortcut chips — quick one-click filters from the gallery-wide tag
          facets, complementing the multi-select FilterChip/tag UI above. */}
      {!tag && (facets.data?.tags?.length ?? 0) > 0 && (
        <TopTagChips tags={facets.data?.tags ?? []} active={tag ?? ""} onToggle={toggleTopTag} />
      )}

      {/* Discovery rows (Featured, Recently published) — a curated/recency slice above
          the main grid, only on the default unfiltered grid view. */}
      {showDiscovery && (
        <>
          <DiscoveryStrip
            heading="Featured"
            description="Hand-picked by your admins."
            items={featuredItems}
          />
          <DiscoveryStrip
            heading="Recently published"
            description="The latest canvases shared with your org."
            items={recentItems}
          />
        </>
      )}

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
          {...galleryEmptyState({
            onClearFilters: clearFilters,
            docsLink: (
              <a
                href="/docs"
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-accent transition-colors hover:text-accent-hover"
              >
                Browse docs
              </a>
            ),
          })}
        />
      )}

      {items.length > 0 && (
        <section aria-label="All gallery canvases" className="space-y-4">
          {showDiscovery && (featuredItems.length > 0 || recentItems.length > 0) && (
            <h2 className="font-serif text-sm font-medium text-fg">Browse all</h2>
          )}
          {view === "grid" ? (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {items.map((item) => (
                <GalleryCard key={item.id} item={item} />
              ))}
            </ul>
          ) : (
            <ul className="space-y-2 lg:space-y-0 lg:divide-y lg:divide-border">
              {items.map((item) => (
                <GalleryRow key={item.id} item={item} />
              ))}
            </ul>
          )}

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
        </section>
      )}
    </div>
  );
}

export { GalleryCard };
