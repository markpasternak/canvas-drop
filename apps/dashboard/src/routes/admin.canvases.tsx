import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { AdminCanvasTable } from "../components/AdminCanvasTable.js";
import { AdminHeader } from "../components/AdminHeader.js";
import { ACCESS_FILTER_OPTIONS } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { conceptColor } from "../components/concept-colors.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterChip, FilterSelect } from "../components/Filters.js";
import { SearchInput } from "../components/SearchInput.js";
import {
  type AccessRung,
  ADMIN_PAGE_SIZE,
  type AdminCanvasSort,
  type AdminCanvasStatus,
} from "../lib/api.js";
import { useAdminCanvases, useMe } from "../lib/queries.js";
import { useDebouncedUrlSearch } from "../lib/use-debounced-url-search.js";
import { usePagination } from "../lib/use-pagination.js";
import type { AdminCanvasesSearch } from "../router.js";

const STATUS_CHIPS: Array<{ value: AdminCanvasStatus | undefined; label: string }> = [
  { value: undefined, label: "All" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
  { value: "archived", label: "Archived" },
  { value: "deleted", label: "Deleted" },
];

const ADMIN_SORT_OPTIONS = [
  { value: "recent", label: "Recent activity" },
  { value: "created", label: "Newest" },
  { value: "title", label: "Title A–Z" },
];

/** Admin all-canvases governance table (§6.10.1). Split from the overview so
 *  owner drill-downs land directly on the table with their filter context visible. */
export default function AdminCanvases() {
  const search = useSearch({ strict: false }) as AdminCanvasesSearch;
  const navigate = useNavigate();
  const { data: me } = useMe();

  const status = search.status;
  const access = search.access;
  const templatable = search.templatable === true;
  const listed = search.listed === true;
  const owner = search.owner;
  const person = search.person?.trim() || undefined;
  const q = search.q?.trim() || undefined;
  const sort = search.sort ?? "recent";
  // No validateSearch on this route, so coerce `page` defensively — a junk
  // `?page=` falls back to 1 rather than letting NaN wedge the pager.
  const rawPage = Number(search.page ?? 1);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  const offset = (page - 1) * ADMIN_PAGE_SIZE;
  const filtering = Boolean(q || status || access || templatable || listed || owner || person);

  const { data, isLoading, isError, isPlaceholderData, refetch } = useAdminCanvases({
    status,
    access,
    templatable: templatable || undefined,
    listed: listed || undefined,
    q,
    owner,
    person,
    sort,
    limit: ADMIN_PAGE_SIZE,
    offset,
  });

  // Search box ⇆ URL `q`, debounced (shared with the member + users lists).
  const [text, setText] = useDebouncedUrlSearch(q, "/admin/canvases");

  // Snap back to page 1 if a refetch lands past the last page (e.g. a takedown
  // shrank the set while paging). Gated on !isPlaceholderData so a stale total
  // can't trigger a spurious reset mid-navigation.
  useEffect(() => {
    if (!isPlaceholderData && data && data.total > 0 && offset >= data.total) {
      navigate({ to: "/admin/canvases", search: (prev) => ({ ...prev, page: 1 }) });
    }
  }, [data, isPlaceholderData, offset, navigate]);

  function setStatus(next: AdminCanvasStatus | undefined) {
    navigate({ to: "/admin/canvases", search: (prev) => ({ ...prev, status: next, page: 1 }) });
  }
  function setAccess(next: string) {
    navigate({
      to: "/admin/canvases",
      search: (prev) => ({
        ...prev,
        access: next === "all" ? undefined : (next as AccessRung),
        page: 1,
      }),
    });
  }
  function setSort(next: string) {
    navigate({
      to: "/admin/canvases",
      search: (prev) => ({
        ...prev,
        sort: next === "recent" ? undefined : (next as AdminCanvasSort),
        page: 1,
      }),
    });
  }
  function setOwner(next: string) {
    navigate({ to: "/admin/canvases", search: (prev) => ({ ...prev, owner: next, page: 1 }) });
  }
  // Boolean gallery facets: a chip toggles its flag on/off. Off clears the key from
  // the URL (undefined) so a clean view keeps a bare URL, like the member list.
  function toggleTemplatable() {
    navigate({
      to: "/admin/canvases",
      search: (prev) => ({ ...prev, templatable: templatable ? undefined : true, page: 1 }),
    });
  }
  function toggleListed() {
    navigate({
      to: "/admin/canvases",
      search: (prev) => ({ ...prev, listed: listed ? undefined : true, page: 1 }),
    });
  }
  function clearFilters() {
    setText("");
    navigate({ to: "/admin/canvases", search: {} });
  }
  function clearOwner() {
    navigate({ to: "/admin/canvases", search: (prev) => ({ ...prev, owner: undefined, page: 1 }) });
  }
  function clearPerson() {
    navigate({
      to: "/admin/canvases",
      search: (prev) => ({ ...prev, person: undefined, page: 1 }),
    });
  }
  function goToPage(next: number) {
    navigate({ to: "/admin/canvases", search: (prev) => ({ ...prev, page: next }) });
  }

  const rows = data?.canvases ?? [];
  const total = data?.total ?? 0;
  const { from, to, hasPrev, hasNext } = usePagination({
    total,
    offset,
    itemCount: rows.length,
    page,
  });
  // Owner drill-down label, derived from the rows (all share one owner).
  const ownerLabel = owner ? (rows[0]?.owner?.email ?? "this owner") : null;

  return (
    <div className="space-y-6">
      <AdminHeader
        eyebrow="Admin · All owners"
        title="Canvases"
        description="Every canvas on the platform, across all owners. Search, filter, and govern."
      />

      {/* Owner drill-down banner — set when arriving from the user table or owner links. */}
      {owner && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm">
          <span className="text-muted">
            Showing canvases owned by <span className="font-medium text-fg">{ownerLabel}</span>
          </span>
          <button
            type="button"
            onClick={clearOwner}
            className="font-medium text-subtle transition-colors hover:text-fg"
          >
            Clear owner filter
          </button>
        </div>
      )}
      {person && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm">
          <span className="text-muted">
            Showing canvases involving <span className="font-medium text-fg">{person}</span>
          </span>
          <button
            type="button"
            onClick={clearPerson}
            className="font-medium text-subtle transition-colors hover:text-fg"
          >
            Clear person filter
          </button>
        </div>
      )}

      {/* Search + sort (member-parity: same primitives as Your canvases). */}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={text}
          onChange={setText}
          placeholder="Search by title, slug, or owner email"
          aria-label="Search all canvases"
        />
        <FilterSelect
          label="Filter by access"
          options={ACCESS_FILTER_OPTIONS}
          value={access ?? "all"}
          onValueChange={setAccess}
        />
        <FilterSelect
          label="Sort canvases"
          options={ADMIN_SORT_OPTIONS}
          value={sort}
          onValueChange={setSort}
        />
      </div>

      {/* Facet chips, same vocabulary as Your canvases: single-select status tabs,
          then the boolean gallery toggles (Template / Listed) set off by a hairline. */}
      <FilterBar>
        {STATUS_CHIPS.map((chip) => (
          <FilterChip
            key={chip.label}
            active={status === chip.value}
            onClick={() => setStatus(chip.value)}
          >
            {chip.label}
          </FilterChip>
        ))}
        <span className="mx-1 h-5 w-px shrink-0 self-center bg-border" aria-hidden />
        <FilterChip
          active={templatable}
          onClick={toggleTemplatable}
          dotClassName={conceptColor("templates").dot}
        >
          Template
        </FilterChip>
        <FilterChip
          active={listed}
          onClick={toggleListed}
          dotClassName={conceptColor("listed").dot}
        >
          Gallery
        </FilterChip>
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

      {isLoading && <p className="text-sm text-muted">Loading canvases…</p>}
      {isError && (
        <EmptyState
          title="Couldn't load canvases"
          description="Something went wrong fetching the platform canvas list."
          action={
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {data && rows.length === 0 && (
        <EmptyState
          title={filtering ? "No canvases match these filters" : "No canvases"}
          description={
            filtering
              ? "Try removing a filter, or clear them all to see everything."
              : "There are no canvases on the platform yet."
          }
          action={
            filtering ? (
              <Button variant="secondary" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      )}
      {rows.length > 0 && (
        <div className="space-y-3">
          <AdminCanvasTable
            canvases={rows}
            viewerId={me?.id}
            onOwnerClick={(ownerRow) => setOwner(ownerRow.id)}
          />
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
        </div>
      )}
    </div>
  );
}
