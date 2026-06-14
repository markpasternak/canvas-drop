import { MagnifyingGlass } from "@phosphor-icons/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AdminUserTable } from "../components/AdminUserTable.js";
import { Button } from "../components/Button.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterSelect } from "../components/Filters.js";
import { PageHeader } from "../components/Surface.js";
import { ADMIN_PAGE_SIZE, type AdminUserSort } from "../lib/api.js";
import { useAdminUsers, useMe } from "../lib/queries.js";

/** Admin users-list search params (plan 006), URL-driven like the canvas list. */
interface AdminUsersSearch {
  q?: string;
  sort?: AdminUserSort;
  page?: number;
}

const USER_SORT_OPTIONS = [
  { value: "active", label: "Recently active" },
  { value: "created", label: "Newest" },
  { value: "name", label: "Name A–Z" },
  { value: "canvases", label: "Most canvases" },
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
  const rawPage = Number(search.page ?? 1);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  const offset = (page - 1) * ADMIN_PAGE_SIZE;
  const filtering = Boolean(q);

  const { data, isLoading, isError, isPlaceholderData, refetch } = useAdminUsers({
    q,
    sort,
    limit: ADMIN_PAGE_SIZE,
    offset,
  });

  const [text, setText] = useState(q ?? "");
  useEffect(() => {
    setText(q ?? "");
  }, [q]);
  useEffect(() => {
    const value = text.trim() || undefined;
    if (value === q) return;
    if (value === undefined) {
      navigate({ to: "/admin/users", search: (prev) => ({ ...prev, q: undefined, page: 1 }) });
      return;
    }
    const id = setTimeout(() => {
      navigate({ to: "/admin/users", search: (prev) => ({ ...prev, q: value, page: 1 }) });
    }, 300);
    return () => clearTimeout(id);
  }, [text, q, navigate]);

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
  function goToPage(next: number) {
    navigate({ to: "/admin/users", search: (prev) => ({ ...prev, page: next }) });
  }

  const users = data?.users ?? [];
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + users.length, total);
  const hasPrev = page > 1;
  const hasNext = offset + users.length < total;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Members, their owned canvases, and governance — block access or grant admin."
        actions={
          <Link to="/admin" className="text-sm font-medium text-accent">
            ← Back to admin
          </Link>
        }
      />

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
            placeholder="Search by name or email"
            aria-label="Search users"
            className="h-9 w-full rounded-lg border border-border bg-surface pr-3 pl-9 text-sm text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
          />
        </div>
        <FilterSelect
          label="Sort users"
          options={USER_SORT_OPTIONS}
          value={sort}
          onValueChange={setSort}
        />
      </div>

      {isLoading && <p className="text-sm text-muted">Loading users…</p>}
      {isError && (
        <EmptyState
          title="Couldn't load users"
          description="Something went wrong fetching the user list."
          action={
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {data && users.length === 0 && (
        <EmptyState
          title={filtering ? "No users match" : "No users"}
          description={filtering ? "Try a different search." : "No members have signed in yet."}
        />
      )}
      {users.length > 0 && (
        <div className="space-y-3">
          <AdminUserTable users={users} meId={me.data?.id} />
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
