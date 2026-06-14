import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { AdminCanvasTable } from "../components/AdminCanvasTable.js";
import { Button } from "../components/Button.js";
import { EmptyState } from "../components/EmptyState.js";
import { PageHeader, Panel } from "../components/Surface.js";
import type { AdminCanvasStatus } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { daysSince, formatBytes } from "../lib/format.js";
import { useAdminCanvases, useAdminOverview } from "../lib/queries.js";

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

/** Bordered container whose 1px gaps reveal the border-colored backing as clean
 *  gridlines between cells. Works at any column count with no double-border seams. */
function StatStrip({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-border shadow-[var(--shadow-panel)]">
      <dl className="grid grid-cols-2 gap-px sm:grid-cols-4">{children}</dl>
    </div>
  );
}

/** Keep the first row per id (see the call site for why pages can overlap). */
function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
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
  // Dedupe by id (keep first occurrence). On invalidation React Query refetches
  // every loaded page with its stored keyset cursor; if a concurrent status
  // change shifted the dataset, a boundary row can land in two pages at once —
  // deduping keeps React from ever seeing a duplicate key.
  const rows = dedupeById(canvases.data?.pages.flatMap((p) => p.canvases) ?? []);

  const ov = overview.data;
  const byStatus = ov?.canvasCountByStatus ?? {};

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

      {/* Platform overview (§6.10.6) — its own loading/error states so it never
          silently disappears when slow or failing. */}
      {overview.isLoading && (
        <div
          className="overflow-hidden rounded-xl border border-border bg-border shadow-[var(--shadow-panel)]"
          aria-busy="true"
        >
          <div className="grid grid-cols-2 gap-px sm:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length skeleton placeholders
                key={i}
                className="h-[78px] animate-pulse bg-surface-sunken"
              />
            ))}
          </div>
        </div>
      )}
      {overview.isError && (
        <EmptyState
          title="Couldn't load the overview"
          description="Something went wrong fetching platform stats."
          action={
            <Button variant="secondary" size="sm" onClick={() => overview.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {ov && (
        <StatStrip>
          <StatCell label="Active canvases" value={byStatus.active ?? 0} />
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
          <StatCell
            label="Users"
            value={ov.userCount}
            hint={ov.newUsers > 0 ? `+${ov.newUsers} in ${ov.recentWindowDays}d` : undefined}
          />
          <StatCell label="File storage" value={formatBytes(ov.totalFileBytes)} />
          <StatCell label="Primitive ops" value={ov.totalOps.toLocaleString()} />
          <StatCell
            label={`New canvases (${ov.recentWindowDays}d)`}
            value={ov.newCanvases.toLocaleString()}
          />
        </StatStrip>
      )}

      {ov && ov.topCanvases.length > 0 && (
        <Panel className="p-4">
          <h2 className="mb-2 text-sm font-semibold text-fg">Top canvases by usage</h2>
          <ul className="space-y-1 text-sm">
            {ov.topCanvases.slice(0, 5).map((t) => (
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
        <div className="space-y-3">
          <AdminCanvasTable canvases={rows} />
          {canvases.hasNextPage && (
            <div className="flex justify-center">
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
        </div>
      )}
    </div>
  );
}
