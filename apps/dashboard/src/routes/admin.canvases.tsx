import { MagnifyingGlass } from "@phosphor-icons/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AdminCanvasTable } from "../components/AdminCanvasTable.js";
import { AdminHeader } from "../components/AdminHeader.js";
import { Button } from "../components/Button.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterChip, FilterSelect } from "../components/Filters.js";
import { ADMIN_PAGE_SIZE, type AdminCanvasSort, type AdminCanvasStatus } from "../lib/api.js";
import { useAdminCanvases } from "../lib/queries.js";

/** Admin canvas-list search params (plan 006), URL-driven so a filtered/drill-down
 *  view is shareable and back-button-able. Read loosely (no validateSearch on the
 *  route — see router.tsx) and coerced here, mirroring the Your-canvases list. */
export interface AdminCanvasesSearch {
  status?: AdminCanvasStatus;
  q?: string;
  sort?: AdminCanvasSort;
  /** Drill-down: restrict to a single owner by user id ("see what they have"). */
  owner?: string;
  page?: number;
}

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

  const status = search.status;
  const owner = search.owner;
  const q = search.q?.trim() || undefined;
  const sort = search.sort ?? "recent";
  // No validateSearch on this route, so coerce `page` defensively — a junk
  // `?page=` falls back to 1 rather than letting NaN wedge the pager.
  const rawPage = Number(search.page ?? 1);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  const offset = (page - 1) * ADMIN_PAGE_SIZE;
  const filtering = Boolean(q || status || owner);

  const { data, isLoading, isError, isPlaceholderData, refetch } = useAdminCanvases({
    status,
    q,
    owner,
    sort,
    limit: ADMIN_PAGE_SIZE,
    offset,
  });

  // Local mirror of the search box, debounced into the `q` route param (mirrors the
  // member list). Seeded on `q` so a shared URL / back-nav repopulates the field.
  const [text, setText] = useState(q ?? "");
  useEffect(() => {
    setText(q ?? "");
  }, [q]);
  useEffect(() => {
    const value = text.trim() || undefined;
    if (value === q) return;
    if (value === undefined) {
      navigate({ to: "/admin/canvases", search: (prev) => ({ ...prev, q: undefined, page: 1 }) });
      return;
    }
    const id = setTimeout(() => {
      navigate({ to: "/admin/canvases", search: (prev) => ({ ...prev, q: value, page: 1 }) });
    }, 300);
    return () => clearTimeout(id);
  }, [text, q, navigate]);

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
  function clearFilters() {
    setText("");
    navigate({ to: "/admin/canvases", search: {} });
  }
  function clearOwner() {
    navigate({ to: "/admin/canvases", search: (prev) => ({ ...prev, owner: undefined, page: 1 }) });
  }
  function goToPage(next: number) {
    navigate({ to: "/admin/canvases", search: (prev) => ({ ...prev, page: next }) });
  }

  const rows = data?.canvases ?? [];
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + rows.length, total);
  const hasPrev = page > 1;
  const hasNext = offset + rows.length < total;
  // Owner drill-down label, derived from the rows (all share one owner).
  const ownerLabel = owner ? (rows[0]?.owner?.email ?? "this owner") : null;

  return (
    <div className="space-y-6">
      <AdminHeader
        title="Canvases"
        description="Search, filter, and govern every canvas on the platform."
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

      {/* Search + sort (member-parity: same primitives as Your canvases). */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[14rem] flex-1">
          <MagnifyingGlass
            size={16}
            className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 text-subtle"
            aria-hidden
          />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search by title, slug, or owner email"
            aria-label="Search all canvases"
            className="h-9 w-full rounded-lg border border-border bg-surface pr-3 pl-9 text-sm text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
          />
        </div>
        <FilterSelect
          label="Sort canvases"
          options={ADMIN_SORT_OPTIONS}
          value={sort}
          onValueChange={setSort}
        />
      </div>

      {/* Status facets (single-select chips). */}
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
          <AdminCanvasTable canvases={rows} onOwnerClick={(ownerRow) => setOwner(ownerRow.id)} />
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
