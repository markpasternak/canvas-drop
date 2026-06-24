import { ArrowSquareOut, Copy, Rows, SquaresFour } from "@phosphor-icons/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { ActionMenu, ActionMenuItem } from "../components/ActionMenu.js";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { previewCoverUrl } from "../components/CanvasCover.js";
import { CanvasGridCard, cardNameLinkClass } from "../components/CanvasGridCard.js";
import { CanvasListRow } from "../components/CanvasListRow.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterSelect } from "../components/Filters.js";
import { coverType } from "../components/GenerativeCover.js";
import { SearchInput } from "../components/SearchInput.js";
import { SegmentedControl } from "../components/SegmentedControl.js";
import { Skeleton } from "../components/Skeleton.js";
import { PageHeader } from "../components/Surface.js";
import { SHARED_PAGE_SIZE, type SharedCanvas } from "../lib/api.js";
import { useClipboardCopy } from "../lib/clipboard.js";
import { useSharedCanvases } from "../lib/queries.js";
import { persistSharedView, resolveSharedView, type SharedView } from "../lib/shared-view.js";
import { useDebouncedUrlSearch } from "../lib/use-debounced-url-search.js";
import { usePagination } from "../lib/use-pagination.js";
import type { SharedSearch } from "../router.js";

const sharedTitle = (item: SharedCanvas) => item.title || "Untitled canvas";

function openLive(item: SharedCanvas) {
  window.open(item.url, "_blank", "noopener,noreferrer");
}

function accessBadge(item: SharedCanvas) {
  if (item.access.kind === "team") return <Badge tone="accent">{item.access.label}</Badge>;
  if (item.access.kind === "whole_org") return <Badge tone="neutral">Whole org</Badge>;
  return <Badge tone="neutral">Direct</Badge>;
}

function accessMeta(item: SharedCanvas) {
  const owner = item.owner?.name ?? "Unknown owner";
  if (item.access.kind === "team") return `${item.access.label} · ${owner}`;
  if (item.access.kind === "whole_org") return `Whole org · ${owner}`;
  return `Direct · ${owner}`;
}

function SharedActions({
  item,
  copy,
}: {
  item: SharedCanvas;
  copy: (value: string, message: string) => void;
}) {
  return (
    <ActionMenu label={`More actions for ${sharedTitle(item)}`}>
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
  );
}

function OwnerStrip({ item }: { item: SharedCanvas }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {item.owner?.avatarUrl ? (
        <img
          src={item.owner.avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="size-5 shrink-0 rounded-full bg-surface-sunken"
        />
      ) : (
        <span className="size-5 shrink-0 rounded-full bg-surface-sunken" aria-hidden />
      )}
      <span className="truncate text-xs text-white/85">{accessMeta(item)}</span>
    </div>
  );
}

function SharedCard({ item }: { item: SharedCanvas }) {
  const copy = useClipboardCopy();
  return (
    <CanvasGridCard
      seed={item.id}
      title={sharedTitle(item)}
      coverType={coverType({ protectedByPassword: item.hasPassword })}
      status="published"
      previewUrl={item.hasPreview ? previewCoverUrl(item.url) : undefined}
      onActivate={() => openLive(item)}
      nameLink={
        <a href={item.url} target="_blank" rel="noreferrer" className={cardNameLinkClass}>
          {sharedTitle(item)}
        </a>
      }
      badges={accessBadge(item)}
      tags={item.tags}
      description={item.description}
      footer={<OwnerStrip item={item} />}
      actions={<SharedActions item={item} copy={copy} />}
    />
  );
}

function SharedRow({ item }: { item: SharedCanvas }) {
  const copy = useClipboardCopy();
  return (
    <CanvasListRow
      seed={item.id}
      previewUrl={item.hasPreview ? previewCoverUrl(item.url, "thumb") : undefined}
      coverType={coverType({ protectedByPassword: item.hasPassword })}
      onActivate={() => openLive(item)}
      nameLink={
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 truncate rounded-sm font-display text-[0.95rem] text-fg underline-offset-2 outline-none transition-colors hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          {sharedTitle(item)}
        </a>
      }
      badges={accessBadge(item)}
      meta={<span className="truncate">{accessMeta(item)}</span>}
      description={item.description}
      actions={<SharedActions item={item} copy={copy} />}
    />
  );
}

function SharedViewToggle({
  value,
  onChange,
}: {
  value: SharedView;
  onChange: (v: SharedView) => void;
}) {
  return (
    <SegmentedControl
      aria-label="Shared layout"
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
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function Shared() {
  const search = useSearch({ strict: false }) as SharedSearch;
  const navigate = useNavigate();
  const q = search.q?.trim() || undefined;
  const sort = search.sort ?? "updated";
  const view = resolveSharedView(search.view);
  const rawPage = Number(search.page ?? 1);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  const offset = (page - 1) * SHARED_PAGE_SIZE;
  const [text, setText] = useDebouncedUrlSearch(q, "/shared");

  const { data, isLoading, isError, isPlaceholderData, refetch } = useSharedCanvases({
    q,
    sort,
    limit: SHARED_PAGE_SIZE,
    offset,
  });

  useEffect(() => {
    if (!isPlaceholderData && data && data.total > 0 && offset >= data.total) {
      navigate({ to: "/shared", search: (prev: SharedSearch) => ({ ...prev, page: 1 }) });
    }
  }, [data, isPlaceholderData, offset, navigate]);

  function clearFilters() {
    setText("");
    navigate({ to: "/shared", search: {} });
  }

  function setSort(next: string) {
    navigate({
      to: "/shared",
      search: (prev: SharedSearch) => ({
        ...prev,
        sort: next === "updated" ? undefined : (next as SharedSearch["sort"]),
        page: 1,
      }),
    });
  }

  function setView(next: SharedView) {
    persistSharedView(next);
    navigate({ to: "/shared", search: (prev: SharedSearch) => ({ ...prev, view: next }) });
  }

  function goToPage(next: number) {
    navigate({ to: "/shared", search: (prev: SharedSearch) => ({ ...prev, page: next }) });
  }

  const items = data?.canvases ?? [];
  const total = data?.total ?? 0;
  const { from, to, hasPrev, hasNext } = usePagination({
    total,
    offset,
    itemCount: items.length,
    page,
  });
  const filtering = Boolean(q);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Shared"
        description="Canvases other people shared with you. Find one and open it."
      />

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={text}
          onChange={setText}
          placeholder="Search shared canvases"
          aria-label="Search shared canvases"
        />
        <FilterSelect
          label="Sort shared canvases"
          options={[
            { value: "updated", label: "Recently updated" },
            { value: "title", label: "Title A-Z" },
            { value: "owner", label: "Owner" },
          ]}
          value={sort}
          onValueChange={setSort}
        />
        <SharedViewToggle value={view} onChange={setView} />
        {filtering && (
          <button
            type="button"
            onClick={clearFilters}
            className="h-9 px-2 text-xs font-medium text-subtle transition-colors hover:text-fg"
          >
            Clear all
          </button>
        )}
      </div>

      {isLoading && <CardSkeletonGrid />}

      {isError && (
        <EmptyState
          title="Couldn't load shared canvases"
          description="We couldn't reach Shared just now. Try again."
          action={
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          }
        />
      )}

      {data && items.length === 0 && !filtering && (
        <EmptyState
          title="Nothing shared with you yet"
          description="Canvases appear here when someone adds you directly, or lists a Team or Whole-org share you can access."
        />
      )}

      {data && items.length === 0 && filtering && (
        <EmptyState
          title="No shared canvases match"
          description="Try a different title, owner, tag, or team name."
          action={
            <Button variant="secondary" size="sm" onClick={clearFilters}>
              Clear search
            </Button>
          }
        />
      )}

      {items.length > 0 && (
        <section aria-label="Shared canvases" className="space-y-4">
          {view === "grid" ? (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {items.map((item) => (
                <SharedCard key={item.id} item={item} />
              ))}
            </ul>
          ) : (
            <ul className="space-y-2 lg:space-y-0 lg:divide-y lg:divide-border">
              {items.map((item) => (
                <SharedRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </section>
      )}

      {data && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
          <span>
            Showing {from}-{to} of {total}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!hasPrev}
              onClick={() => goToPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!hasNext}
              onClick={() => goToPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
