import { MagnifyingGlass } from "@phosphor-icons/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AdminCanvasTable } from "../components/AdminCanvasTable.js";
import { Button } from "../components/Button.js";
import { CollapsibleSection } from "../components/CollapsibleSection.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterChip, FilterSelect } from "../components/Filters.js";
import { PageHeader, Panel } from "../components/Surface.js";
import { ADMIN_PAGE_SIZE, type AdminCanvasSort, type AdminCanvasStatus } from "../lib/api.js";
import { daysSince, formatBytes, formatUsd } from "../lib/format.js";
import { useAdminAiUsage, useAdminCanvases, useAdminOverview } from "../lib/queries.js";

/** One cell in the platform stat strip. Cells share a single bordered surface
 *  (gridlines come from the parent's gap), so the block reads as one instrument
 *  panel — not a grid of identical SaaS hero-metric cards. */
function StatCell({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="bg-surface p-4">
      <dt className="text-[0.6875rem] font-medium text-subtle">{label}</dt>
      <dd className="mt-1 font-semibold text-2xl text-fg tracking-tight tabular-nums">{value}</dd>
      {hint && <div className="mt-0.5 text-xs text-subtle">{hint}</div>}
    </div>
  );
}

/** A ranked AI-spend list (by canvas), §6.10.7. Cost-first since spend is the thing
 *  an admin scans for; `sub` carries the owner email (canvas/owner attribution). */
function SpendPanel({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ key: string; label: string; sub?: string | null; costUsd: number; calls: number }>;
}) {
  return (
    <Panel className="p-4">
      <h2 className="mb-2 text-sm font-semibold text-fg">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No AI usage yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((r) => (
            <li key={r.key} className="flex items-baseline justify-between gap-3 text-muted">
              <span className="min-w-0 truncate">
                {r.label}
                {r.sub && <span className="ml-2 text-subtle">{r.sub}</span>}
              </span>
              <span className="shrink-0 tabular-nums">
                <span className="font-medium text-fg">{formatUsd(r.costUsd)}</span>
                <span className="ml-2 text-subtle">{r.calls.toLocaleString()} calls</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Admin canvas-list search params (plan 006), URL-driven so a filtered/drill-down
 *  view is shareable and back-button-able. Read loosely (no validateSearch on the
 *  route — see router.tsx) and coerced here, mirroring the Your-canvases list. */
interface AdminSearch {
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

/** Admin dashboard (§6.10) — platform overview + the all-canvases governance
 *  table. Admin-only: the server 404s non-admins and the nav entry is hidden.
 *  Privacy posture (plan 006): admin governs OBJECTS (canvases, owners, platform),
 *  never AUDIENCE behavior — AI spend is by canvas/owner, there are no per-user
 *  view breakdowns, and audit/users surfaces stay object-scoped. */
export default function AdminDashboard() {
  const search = useSearch({ strict: false }) as AdminSearch;
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

  const overview = useAdminOverview();
  const aiUsage = useAdminAiUsage();
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
      navigate({ to: "/admin", search: (prev) => ({ ...prev, q: undefined, page: 1 }) });
      return;
    }
    const id = setTimeout(() => {
      navigate({ to: "/admin", search: (prev) => ({ ...prev, q: value, page: 1 }) });
    }, 300);
    return () => clearTimeout(id);
  }, [text, q, navigate]);

  // Snap back to page 1 if a refetch lands past the last page (e.g. a takedown
  // shrank the set while paging). Gated on !isPlaceholderData so a stale total
  // can't trigger a spurious reset mid-navigation.
  useEffect(() => {
    if (!isPlaceholderData && data && data.total > 0 && offset >= data.total) {
      navigate({ to: "/admin", search: (prev) => ({ ...prev, page: 1 }) });
    }
  }, [data, isPlaceholderData, offset, navigate]);

  function setStatus(next: AdminCanvasStatus | undefined) {
    navigate({ to: "/admin", search: (prev) => ({ ...prev, status: next, page: 1 }) });
  }
  function setSort(next: string) {
    navigate({
      to: "/admin",
      search: (prev) => ({
        ...prev,
        sort: next === "recent" ? undefined : (next as AdminCanvasSort),
        page: 1,
      }),
    });
  }
  function clearFilters() {
    setText("");
    navigate({ to: "/admin", search: {} });
  }
  function clearOwner() {
    navigate({ to: "/admin", search: (prev) => ({ ...prev, owner: undefined, page: 1 }) });
  }
  function goToPage(next: number) {
    navigate({ to: "/admin", search: (prev) => ({ ...prev, page: next }) });
  }

  const ov = overview.data;
  const byStatus = ov?.canvasCountByStatus ?? {};
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
      <PageHeader
        title="Admin"
        description="Platform-wide visibility and governance. Take down, restore, and set defaults."
        actions={
          <div className="flex items-center gap-4">
            <Link to="/admin/users" className="text-sm font-medium text-accent">
              Users
            </Link>
            <Link to="/admin/settings" className="text-sm font-medium text-accent">
              Settings & defaults
            </Link>
          </div>
        }
      />

      {/* Platform overview (§6.10.6) — collapsible, state remembered in localStorage.
          All aggregates (no per-user behavioral data): scale + engagement (row 1),
          activity + cost (row 2), canvas lifecycle (row 3). */}
      <CollapsibleSection title="Platform overview" storageKey="admin:section:overview" flush>
        {overview.isLoading ? (
          <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4" aria-busy="true">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length skeleton placeholders
                key={i}
                className="h-[78px] animate-pulse bg-surface-sunken"
              />
            ))}
          </div>
        ) : overview.isError ? (
          <div className="p-5">
            <EmptyState
              title="Couldn't load the overview"
              description="Something went wrong fetching platform stats."
              action={
                <Button variant="secondary" size="sm" onClick={() => overview.refetch()}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : ov ? (
          <dl className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
            {/* Row 1 — platform scale + engagement (the headline KPIs). */}
            <StatCell label="Active canvases" value={byStatus.active ?? 0} />
            <StatCell
              label="Users"
              value={ov.userCount}
              hint={ov.newUsers > 0 ? `+${ov.newUsers} in ${ov.recentWindowDays}d` : undefined}
            />
            <StatCell label="Total views" value={ov.totalViews.toLocaleString()} />
            <StatCell label="Unique viewers" value={ov.uniqueViewers.toLocaleString()} />
            {/* Row 2 — production activity + what it costs. */}
            <StatCell label="Deploys" value={ov.totalDeploys.toLocaleString()} />
            <StatCell label="Primitive ops" value={ov.totalOps.toLocaleString()} />
            <StatCell
              label="AI spend"
              value={formatUsd(ov.aiCostUsd)}
              hint={`${ov.aiCalls.toLocaleString()} calls · ${ov.aiTokens.toLocaleString()} tokens`}
            />
            <StatCell label="File storage" value={formatBytes(ov.totalFileBytes)} />
            {/* Row 3 — canvas lifecycle (created → disabled → archived → deleted). */}
            <StatCell
              label={`New canvases (${ov.recentWindowDays}d)`}
              value={ov.newCanvases.toLocaleString()}
            />
            <StatCell label="Disabled" value={byStatus.disabled ?? 0} />
            <StatCell label="Archived" value={byStatus.archived ?? 0} />
            <StatCell
              label="Deleted"
              value={byStatus.deleted ?? 0}
              hint={
                ov.oldestDeletedAt !== null
                  ? `oldest ${daysSince(ov.oldestDeletedAt)}d — awaiting purge`
                  : undefined
              }
            />
          </dl>
        ) : null}
      </CollapsibleSection>

      {/* Top canvases by usage — an aggregate object fact (most-active canvases by
          recorded ops), contract-safe. Folds away so the governance table stays close. */}
      {ov && ov.topCanvases.length > 0 && (
        <CollapsibleSection title="Top canvases by usage" storageKey="admin:section:topCanvases">
          <ul className="space-y-1 text-sm">
            {ov.topCanvases.slice(0, 5).map((t) => (
              <li key={t.canvasId} className="flex justify-between text-muted">
                <span className="font-mono">{t.slug ?? t.canvasId}</span>
                <span className="tabular-nums">{t.ops.toLocaleString()} ops</span>
              </li>
            ))}
          </ul>
        </CollapsibleSection>
      )}

      {/* AI usage breakdown (§6.10.7) — top-spending canvases and their owners.
          Re-attributed to canvas/owner only (plan 006): no per-user spend. Folded
          by default so the governance table stays close on first load. */}
      {aiUsage.data && aiUsage.data.byCanvas.length > 0 && (
        <CollapsibleSection title="AI usage" storageKey="admin:section:aiUsage" defaultOpen={false}>
          <SpendPanel
            title="AI spend by canvas"
            rows={aiUsage.data.byCanvas.map((c2) => ({
              key: c2.canvasId,
              label: c2.title || c2.slug || c2.canvasId,
              sub: c2.ownerEmail,
              costUsd: c2.costUsd,
              calls: c2.calls,
            }))}
          />
        </CollapsibleSection>
      )}

      {/* Audit log (placeholder, plan 006) — recorded today, browser unbuilt. When
          built it will show governance MUTATIONS (deploy/disable/block/settings),
          never consumption — accountability without surveillance. */}
      <CollapsibleSection title="Audit log" storageKey="admin:section:audit" defaultOpen={false}>
        <EmptyState
          title="Audit log — coming soon"
          description="Governance actions (takedowns, restores, blocks, settings changes) are already recorded. A browsable trail will land here; it will show who changed what, never who viewed what."
        />
      </CollapsibleSection>

      {/* Owner drill-down banner — set when arriving from the user table. */}
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
          <AdminCanvasTable canvases={rows} />
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
