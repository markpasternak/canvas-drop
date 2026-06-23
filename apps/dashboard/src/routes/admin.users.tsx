import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { AddUsersPanel } from "../components/AddUsersPanel.js";
import { AdminHeader } from "../components/AdminHeader.js";
import { AdminUserTable } from "../components/AdminUserTable.js";
import { Button } from "../components/Button.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterChip, FilterSelect } from "../components/Filters.js";
import { SearchInput } from "../components/SearchInput.js";
import {
  ADMIN_PAGE_SIZE,
  type AdminPersonKind,
  type AdminPublicCapabilityFilter,
  type AdminUserSort,
} from "../lib/api.js";
import { useAdminPeople, useMe } from "../lib/queries.js";
import { useDebouncedUrlSearch } from "../lib/use-debounced-url-search.js";
import { usePagination } from "../lib/use-pagination.js";

/** Admin users-list search params (plan 006), URL-driven like the canvas list. */
interface AdminUsersSearch {
  q?: string;
  sort?: AdminUserSort;
  kind?: AdminPersonKind;
  pending?: boolean;
  blocked?: boolean;
  admin?: boolean;
  permit?: boolean;
  publicCapability?: AdminPublicCapabilityFilter;
  page?: number;
}

const USER_SORT_OPTIONS = [
  { value: "active", label: "Recently active" },
  { value: "created", label: "Newest" },
  { value: "name", label: "Name A–Z" },
  { value: "canvases", label: "Most canvases" },
];

const KIND_OPTIONS = [
  { value: "all", label: "All people" },
  { value: "org_member", label: "Org members" },
  { value: "external", label: "External" },
  { value: "pending", label: "Pending sign-in" },
];

const PUBLIC_OPTIONS = [
  { value: "all", label: "All public states" },
  { value: "allowed", label: "Public allowed" },
  { value: "revoked", label: "Public revoked" },
];

/** Admin user management (plan 006) — list members with their owned-canvas count,
 *  role, and block status, and govern them (block/unblock, promote/demote). Object/
 *  identity facts only; no per-user behavioral data. Admin-only (server 404s
 *  non-admins; the entry is reached from the Admin page). */
export default function AdminUsers() {
  const search = useSearch({ strict: false }) as AdminUsersSearch;
  const navigate = useNavigate();
  const me = useMe();

  const q = search.q?.trim() || undefined;
  const sort = search.sort ?? "active";
  const kind = search.kind;
  const pending = search.pending === true;
  const blocked = search.blocked === true;
  const adminOnly = search.admin === true;
  const permit = search.permit === true;
  const publicCapability = search.publicCapability;
  const rawPage = Number(search.page ?? 1);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  const offset = (page - 1) * ADMIN_PAGE_SIZE;
  const filtering = Boolean(
    q || kind || pending || blocked || adminOnly || permit || publicCapability,
  );

  const { data, isLoading, isError, isPlaceholderData, refetch } = useAdminPeople({
    q,
    sort,
    kind,
    pending,
    blocked,
    admin: adminOnly,
    permit,
    publicCapability,
    limit: ADMIN_PAGE_SIZE,
    offset,
  });

  const [text, setText] = useDebouncedUrlSearch(q, "/admin/users");

  useEffect(() => {
    if (!isPlaceholderData && data && data.total > 0 && offset >= data.total) {
      navigate({ to: "/admin/users", search: (prev) => ({ ...prev, page: 1 }) });
    }
  }, [data, isPlaceholderData, offset, navigate]);

  function setSort(next: string) {
    navigate({
      to: "/admin/users",
      search: (prev) => ({
        ...prev,
        sort: next === "active" ? undefined : (next as AdminUserSort),
        page: 1,
      }),
    });
  }
  function setKind(next: string) {
    navigate({
      to: "/admin/users",
      search: (prev) => ({
        ...prev,
        kind: next === "all" ? undefined : (next as AdminPersonKind),
        page: 1,
      }),
    });
  }
  function setPublicCapability(next: string) {
    navigate({
      to: "/admin/users",
      search: (prev) => ({
        ...prev,
        publicCapability: next === "all" ? undefined : (next as AdminPublicCapabilityFilter),
        page: 1,
      }),
    });
  }
  function toggleFlag(flag: "pending" | "blocked" | "admin" | "permit", value: boolean) {
    navigate({
      to: "/admin/users",
      search: (prev) => ({ ...prev, [flag]: value ? undefined : true, page: 1 }),
    });
  }
  function clearFilters() {
    setText("");
    navigate({ to: "/admin/users", search: {} });
  }
  function goToPage(next: number) {
    navigate({ to: "/admin/users", search: (prev) => ({ ...prev, page: next }) });
  }

  const people = data?.people ?? [];
  const total = data?.total ?? 0;
  const { from, to, hasPrev, hasNext } = usePagination({
    total,
    offset,
    itemCount: people.length,
    page,
  });

  return (
    <div className="space-y-6">
      <AdminHeader
        title="People"
        description="Signed-in members, external emails, sign-in permits, pending grants, and access governance."
      />

      <AddUsersPanel />

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={text}
          onChange={setText}
          placeholder="Search people by name or email"
          aria-label="Search people"
        />
        <FilterSelect
          label="Filter people by kind"
          options={KIND_OPTIONS}
          value={kind ?? "all"}
          onValueChange={setKind}
        />
        <FilterSelect
          label="Filter by public publishing state"
          options={PUBLIC_OPTIONS}
          value={publicCapability ?? "all"}
          onValueChange={setPublicCapability}
        />
        <FilterSelect
          label="Sort people"
          options={USER_SORT_OPTIONS}
          value={sort}
          onValueChange={setSort}
        />
      </div>

      <FilterBar>
        <FilterChip active={pending} onClick={() => toggleFlag("pending", pending)}>
          Pending grants
        </FilterChip>
        <FilterChip active={blocked} onClick={() => toggleFlag("blocked", blocked)}>
          Blocked
        </FilterChip>
        <FilterChip active={adminOnly} onClick={() => toggleFlag("admin", adminOnly)}>
          Admins
        </FilterChip>
        <FilterChip active={permit} onClick={() => toggleFlag("permit", permit)}>
          Sign-in permits
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

      {isLoading && <p className="text-sm text-muted">Loading people…</p>}
      {isError && (
        <EmptyState
          title="Couldn't load people"
          description="Something went wrong fetching the People directory."
          action={
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {data && people.length === 0 && (
        <EmptyState
          title={filtering ? "No people match" : "No people"}
          description={
            filtering ? "Try a different search." : "No people have signed in or been invited yet."
          }
        />
      )}
      {people.length > 0 && (
        <div className="space-y-3">
          <AdminUserTable people={people} meId={me.data?.id} />
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
