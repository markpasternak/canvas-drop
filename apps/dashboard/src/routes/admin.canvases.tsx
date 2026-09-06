import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AdminBooleanFilter } from "../components/AdminBooleanFilter.js";
import { AdminCanvasInspector } from "../components/AdminCanvasInspector.js";
import {
  ADMIN_OPERATION_LABELS,
  AdminCanvasOperationDialog,
} from "../components/AdminCanvasOperationDialog.js";
import { AdminCanvasTable } from "../components/AdminCanvasTable.js";
import { AdminHeader } from "../components/AdminHeader.js";
import { AdminSavedViews } from "../components/AdminSavedViews.js";
import {
  AdminTablePreferences,
  useAdminTablePreferences,
} from "../components/AdminTablePreferences.js";
import { ACCESS_FILTER_OPTIONS } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterChip, FilterSelect } from "../components/Filters.js";
import { SearchInput } from "../components/SearchInput.js";
import {
  adminCanvasConditions,
  CANVAS_BOOLEAN_FILTERS,
  normalizeAdminCanvasSearch,
} from "../lib/admin-filters.js";
import {
  type AccessRung,
  ADMIN_PAGE_SIZE,
  type AdminCanvasContextFilter,
  type AdminCanvasExpiryFilter,
  type AdminCanvasOperation,
  type AdminCanvasSort,
  type AdminCanvasStatus,
} from "../lib/api.js";
import { useAdminCanvases, useMe } from "../lib/queries.js";
import { useDebouncedUrlSearch } from "../lib/use-debounced-url-search.js";
import { usePagination } from "../lib/use-pagination.js";

const STATUS_CHIPS: Array<{ value: AdminCanvasStatus | undefined; label: string }> = [
  { value: undefined, label: "Not deleted" },
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

const CONTEXT_OPTIONS = [
  { value: "all", label: "All contexts" },
  { value: "personal", label: "Personal" },
  { value: "org", label: "Org" },
  { value: "team", label: "Team shared" },
];

const EXPIRY_OPTIONS = [
  { value: "all", label: "All expiries" },
  { value: "none", label: "No expiry" },
  { value: "active", label: "Expires later" },
  { value: "expired", label: "Expired" },
  { value: "not_expired", label: "Not expired (including no expiry)" },
];

/** Admin all-canvases governance table (§6.10.1). Split from the overview so
 *  owner drill-downs land directly on the table with their filter context visible. */
export default function AdminCanvases() {
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = normalizeAdminCanvasSearch(routeSearch);
  const inspectId =
    typeof routeSearch.inspect === "string" ? routeSearch.inspect.slice(0, 100) : undefined;
  const navigate = useNavigate();
  const { data: me } = useMe();
  const [tableSettings, setTableSettings] = useAdminTablePreferences(me?.id);
  const [selected, setSelected] = useState<string[]>([]);
  const [operation, setOperation] = useState<{
    action: AdminCanvasOperation;
    ids: string[];
  } | null>(null);
  const scope = JSON.stringify(search);
  const [selectionScope, setSelectionScope] = useState(scope);
  if (selectionScope !== scope) {
    setSelectionScope(scope);
    setSelected([]);
  }

  const status = search.status;
  const access = search.access;
  const expiry = search.expiry;
  const context = search.context;
  const owner = search.owner;
  const person = search.person?.trim() || undefined;
  const q = search.q?.trim() || undefined;
  const sort = search.sort ?? "recent";
  // No validateSearch on this route, so coerce `page` defensively — a junk
  // `?page=` falls back to 1 rather than letting NaN wedge the pager.
  const rawPage = Number(search.page ?? 1);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  const offset = (page - 1) * ADMIN_PAGE_SIZE;
  const conditions = adminCanvasConditions(search);
  const filtering = conditions.length > 0;

  const { data, isLoading, isError, isPlaceholderData, refetch } = useAdminCanvases({
    purge: search.purge,
    status,
    access,
    public: search.public,
    password: search.password,
    external: search.external,
    pending: search.pending,
    expiry,
    context,
    templatable: search.templatable,
    listed: search.listed,
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
  function setContext(next: string) {
    navigate({
      to: "/admin/canvases",
      search: (prev) => ({
        ...prev,
        context: next === "all" ? undefined : (next as AdminCanvasContextFilter),
        page: 1,
      }),
    });
  }
  function setExpiry(next: string) {
    navigate({
      to: "/admin/canvases",
      search: (prev) => ({
        ...prev,
        expiry: next === "all" ? undefined : (next as AdminCanvasExpiryFilter),
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
  function setFlag(
    flag: (typeof CANVAS_BOOLEAN_FILTERS)[number]["key"],
    value: boolean | undefined,
  ) {
    navigate({
      to: "/admin/canvases",
      search: (prev) => ({ ...prev, [flag]: value, page: 1 }),
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
          label="Filter by context"
          options={CONTEXT_OPTIONS}
          value={context ?? "all"}
          onValueChange={setContext}
        />
        <FilterSelect
          label="Filter by expiry"
          options={EXPIRY_OPTIONS}
          value={expiry ?? "all"}
          onValueChange={setExpiry}
        />
        <FilterSelect
          label="Sort canvases"
          options={ADMIN_SORT_OPTIONS}
          value={sort}
          onValueChange={setSort}
        />
        <FilterSelect
          label="Purge state"
          value={search.purge ?? "all"}
          options={[
            { value: "all", label: "Any purge state" },
            { value: "eligible", label: "Retention elapsed" },
            { value: "retained", label: "Within retention" },
            { value: "incomplete", label: "Cleanup incomplete" },
            { value: "complete", label: "Purged" },
          ]}
          onValueChange={(value) =>
            navigate({
              to: "/admin/canvases",
              search: (previous) => ({
                ...previous,
                page: 1,
                status: value === "all" ? status : "deleted",
                purge:
                  value === "all"
                    ? undefined
                    : (value as "eligible" | "retained" | "incomplete" | "complete"),
              }),
            })
          }
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

      <div className="space-y-3">
        {me && (
          <AdminSavedViews
            key={me.id}
            userId={me.id}
            search={search}
            onApply={(saved) => navigate({ to: "/admin/canvases", search: { ...saved, page: 1 } })}
          />
        )}
        <p className="text-xs text-muted">
          Match all conditions (AND). Effective public means published, unexpired, and permitted by
          the owner and instance; a password can still be required.
        </p>
        <div className="flex flex-wrap gap-2">
          {CANVAS_BOOLEAN_FILTERS.map(({ key, label }) => (
            <AdminBooleanFilter
              key={key}
              label={label}
              value={search[key]}
              onChange={(value) => setFlag(key, value)}
            />
          ))}
        </div>
        {conditions.length > 0 && (
          <section className="flex flex-wrap gap-2" aria-label="Active conditions">
            {conditions.map(({ key, label }) => (
              <Button
                key={key}
                size="sm"
                variant="ghost"
                aria-label={`Remove ${label}`}
                onClick={() => {
                  if (key === "q") setText("");
                  navigate({
                    to: "/admin/canvases",
                    search: (prev) => ({ ...prev, [key]: undefined, page: 1 }),
                  });
                }}
              >
                {label} ×
              </Button>
            ))}
          </section>
        )}
      </div>

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
          <AdminTablePreferences value={tableSettings} onChange={setTableSettings} />
          {selected.length > 0 && (
            <section
              aria-label="Selected canvas actions"
              className="space-y-2 rounded-lg border border-border p-3"
            >
              <p className="text-sm font-medium">
                {selected.length} selected on this page. Other matches are excluded.
              </p>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(ADMIN_OPERATION_LABELS) as AdminCanvasOperation[]).map((action) => (
                  <Button
                    key={action}
                    size="sm"
                    variant="secondary"
                    disabled={isPlaceholderData}
                    onClick={() => setOperation({ action, ids: [...selected] })}
                  >
                    {ADMIN_OPERATION_LABELS[action]} selected
                  </Button>
                ))}
                <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                  Clear selection
                </Button>
              </div>
            </section>
          )}
          <AdminCanvasTable
            canvases={rows}
            viewerId={me?.id}
            hiddenColumns={tableSettings.hidden}
            compact={tableSettings.compact}
            selected={selected}
            onSelect={setSelected}
            onOperation={(action, id) => setOperation({ action, ids: [id] })}
            onInspect={(id) =>
              navigate({
                to: "/admin/canvases",
                resetScroll: false,
                search: (prev) => ({ ...prev, inspect: id }),
              })
            }
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
      {inspectId && (
        <AdminCanvasInspector
          key={inspectId}
          canvasId={inspectId}
          onClose={() =>
            navigate({
              to: "/admin/canvases",
              resetScroll: false,
              search: (prev) => ({ ...prev, inspect: undefined }),
            })
          }
        />
      )}
      {operation && (
        <AdminCanvasOperationDialog
          key={`${operation.action}:${operation.ids.join(",")}`}
          action={operation.action}
          ids={operation.ids}
          onClose={() => {
            setOperation(null);
            setSelected([]);
          }}
        />
      )}
    </div>
  );
}
