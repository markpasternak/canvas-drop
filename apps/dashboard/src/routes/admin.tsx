import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AdminCanvasTable } from "../components/AdminCanvasTable.js";
import { Button } from "../components/Button.js";
import { EmptyState } from "../components/EmptyState.js";
import { PageHeader, Panel } from "../components/Surface.js";
import type { AdminCanvasStatus } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { formatBytes } from "../lib/format.js";
import { useAdminCanvases, useAdminOverview } from "../lib/queries.js";

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-fg">{value}</div>
    </div>
  );
}

const FILTERS: Array<{ id: AdminCanvasStatus | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "disabled", label: "Disabled" },
  { id: "archived", label: "Archived" },
  { id: "deleted", label: "Deleted" },
];

/** Admin dashboard (§6.10) — platform overview + the all-canvases governance
 *  table. Admin-only: the server 404s non-admins and the nav entry is hidden. */
export default function AdminDashboard() {
  const [filter, setFilter] = useState<AdminCanvasStatus | "all">("all");
  const status = filter === "all" ? undefined : filter;
  const overview = useAdminOverview();
  const canvases = useAdminCanvases(status);
  // Flatten the keyset pages into one list for the table.
  const rows = canvases.data?.pages.flatMap((p) => p.canvases) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin"
        description="Platform-wide visibility and governance. Take down, restore, and set defaults."
        actions={
          <Link to="/admin/settings" className="text-sm font-medium text-accent">
            Settings & defaults
          </Link>
        }
      />

      {/* Platform overview (§6.10.6) */}
      {overview.data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Active canvases" value={overview.data.canvasCountByStatus.active ?? 0} />
          <StatCard label="Disabled" value={overview.data.canvasCountByStatus.disabled ?? 0} />
          <StatCard label="Users" value={overview.data.userCount} />
          <StatCard label="File storage" value={formatBytes(overview.data.totalFileBytes)} />
        </div>
      )}

      {overview.data && overview.data.topCanvases.length > 0 && (
        <Panel className="p-4">
          <h2 className="mb-2 text-sm font-semibold text-fg">Top canvases by usage</h2>
          <ul className="space-y-1 text-sm">
            {overview.data.topCanvases.slice(0, 5).map((t) => (
              <li key={t.canvasId} className="flex justify-between text-muted">
                <span className="font-mono">{t.slug ?? t.canvasId}</span>
                <span className="tabular-nums">{t.ops.toLocaleString()} ops</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* Status filter */}
      <nav className="flex flex-wrap gap-1" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={cn(
              "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
              filter === f.id
                ? "border-accent/30 bg-accent-subtle text-accent"
                : "border-transparent text-muted hover:bg-surface-hover hover:text-fg",
            )}
          >
            {f.label}
          </button>
        ))}
      </nav>

      {canvases.isLoading && <p className="text-sm text-muted">Loading canvases…</p>}
      {canvases.isError && (
        <EmptyState
          title="Couldn't load canvases"
          description="Something went wrong fetching the platform canvas list."
          action={
            <Button variant="secondary" size="sm" onClick={() => canvases.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {canvases.data && rows.length === 0 && (
        <EmptyState title="No canvases" description="Nothing matches this filter." />
      )}
      {rows.length > 0 && (
        <>
          <AdminCanvasTable canvases={rows} />
          {canvases.hasNextPage && (
            <div className="flex justify-center pt-2">
              <Button
                variant="secondary"
                size="sm"
                loading={canvases.isFetchingNextPage}
                onClick={() => canvases.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
