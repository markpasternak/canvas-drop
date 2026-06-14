import { CaretRight } from "@phosphor-icons/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { AdminHeader } from "../components/AdminHeader.js";
import { Button } from "../components/Button.js";
import { CollapsibleSection } from "../components/CollapsibleSection.js";
import { EmptyState } from "../components/EmptyState.js";
import { daysSince, formatBytes, formatUsd } from "../lib/format.js";
import { useAdminAiUsage, useAdminOverview } from "../lib/queries.js";
import type { AdminCanvasesSearch } from "./admin.canvases.js";

/** One cell in the platform stat strip. Cells share a single bordered surface
 *  (gridlines come from the parent's gap), so the block reads as one instrument
 *  panel — not a grid of identical SaaS hero-metric cards. */
function StatCell({
  label,
  value,
  hint,
  emphasis = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="min-h-[5.5rem] bg-surface px-4 py-3.5">
      <dt className="text-[0.6875rem] font-medium text-subtle">{label}</dt>
      <dd
        className={
          emphasis
            ? "mt-1 font-semibold text-[1.75rem] leading-none text-fg tracking-tight tabular-nums"
            : "mt-1 font-semibold text-xl leading-none text-fg tracking-tight tabular-nums"
        }
      >
        {value}
      </dd>
      {hint && <div className="mt-1 text-xs text-subtle">{hint}</div>}
    </div>
  );
}

function CompactMetric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.6875rem] font-medium text-subtle">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-fg tabular-nums">{value}</dd>
      {hint && <div className="mt-0.5 truncate text-xs text-subtle">{hint}</div>}
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
    <div className="rounded-lg border border-border bg-surface-sunken/40">
      <h2 className="border-border border-b px-4 py-3 text-sm font-semibold text-fg">{title}</h2>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted">No AI usage yet.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {rows.map((r) => (
            <li key={r.key}>
              <Link
                to="/canvases/$id"
                params={{ id: r.key }}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-muted transition-colors hover:bg-surface-hover"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-fg">{r.label}</span>
                  {r.sub && <span className="block truncate text-xs text-subtle">{r.sub}</span>}
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="block font-medium text-fg">{formatUsd(r.costUsd)}</span>
                  <span className="text-xs text-subtle">{r.calls.toLocaleString()} calls</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const CANVAS_SEARCH_KEYS: Array<keyof AdminCanvasesSearch> = [
  "owner",
  "status",
  "q",
  "sort",
  "page",
];

function hasCanvasSearch(search: AdminCanvasesSearch): boolean {
  return CANVAS_SEARCH_KEYS.some((key) => search[key] !== undefined);
}

function AdminOverview() {
  const overview = useAdminOverview();
  const aiUsage = useAdminAiUsage();
  const ov = overview.data;
  const byStatus = ov?.canvasCountByStatus ?? {};

  return (
    <div className="space-y-6">
      <AdminHeader
        title="Overview"
        description="Platform-wide visibility and governance health at a glance."
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
          <div className="bg-surface">
            <dl className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
              {/* Headline KPIs: the first thing an admin should scan. */}
              <StatCell label="Active canvases" value={byStatus.active ?? 0} emphasis />
              <StatCell
                label="Users"
                value={ov.userCount}
                hint={ov.newUsers > 0 ? `+${ov.newUsers} in ${ov.recentWindowDays}d` : undefined}
                emphasis
              />
              <StatCell label="Total views" value={ov.totalViews.toLocaleString()} emphasis />
              <StatCell
                label="AI spend"
                value={formatUsd(ov.aiCostUsd)}
                hint={`${ov.aiCalls.toLocaleString()} calls`}
                emphasis
              />
            </dl>

            <dl className="grid gap-x-8 gap-y-4 border-border border-t px-4 py-3.5 sm:grid-cols-4 lg:grid-cols-8">
              <CompactMetric label="Unique viewers" value={ov.uniqueViewers.toLocaleString()} />
              <CompactMetric label="Deploys" value={ov.totalDeploys.toLocaleString()} />
              <CompactMetric label="Primitive ops" value={ov.totalOps.toLocaleString()} />
              <CompactMetric label="File storage" value={formatBytes(ov.totalFileBytes)} />
              <CompactMetric
                label={`New (${ov.recentWindowDays}d)`}
                value={ov.newCanvases.toLocaleString()}
              />
              <CompactMetric label="Disabled" value={byStatus.disabled ?? 0} />
              <CompactMetric label="Archived" value={byStatus.archived ?? 0} />
              <CompactMetric
                label="Deleted"
                value={byStatus.deleted ?? 0}
                hint={
                  ov.oldestDeletedAt !== null
                    ? `oldest ${daysSince(ov.oldestDeletedAt)}d`
                    : undefined
                }
              />
            </dl>
          </div>
        ) : null}
      </CollapsibleSection>

      {/* Top canvases by usage — an aggregate object fact (most-active canvases by
          recorded ops), contract-safe. Clickable so admins can inspect the canvas. */}
      {ov && ov.topCanvases.length > 0 && (
        <CollapsibleSection title="Top canvases by usage" storageKey="admin:section:topCanvases">
          <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface-sunken/40 text-sm">
            {ov.topCanvases.slice(0, 5).map((t, index) => {
              const title = t.title || t.slug || t.canvasId;
              const meta = t.title && t.slug ? t.slug : t.canvasId;
              return (
                <li key={t.canvasId}>
                  <Link
                    to="/canvases/$id"
                    params={{ id: t.canvasId }}
                    className="group grid grid-cols-[2rem_1fr_auto_1rem] items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface-hover"
                  >
                    <span className="text-right text-xs text-subtle tabular-nums">{index + 1}</span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-fg transition-colors group-hover:text-accent">
                        {title}
                      </span>
                      <span className="block truncate text-xs text-subtle">{meta}</span>
                    </span>
                    <span className="shrink-0 text-sm text-muted tabular-nums">
                      {t.ops.toLocaleString()} ops
                    </span>
                    <CaretRight
                      size={14}
                      weight="bold"
                      aria-hidden
                      className="text-subtle transition-colors group-hover:text-accent"
                    />
                  </Link>
                </li>
              );
            })}
          </ol>
        </CollapsibleSection>
      )}

      {/* AI usage breakdown (§6.10.7) — top-spending canvases and their owners.
          Re-attributed to canvas/owner only (plan 006): no per-user spend. */}
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
    </div>
  );
}

/** Admin overview (§6.10). Old filtered `/admin?...` links are redirected to the
 *  dedicated canvas governance tab so shared links and back-button state survive
 *  the IA split. */
export default function AdminDashboard() {
  const search = useSearch({ strict: false }) as AdminCanvasesSearch;
  const navigate = useNavigate();
  const redirectToCanvases = hasCanvasSearch(search);

  useEffect(() => {
    if (!redirectToCanvases) return;
    navigate({
      to: "/admin/canvases",
      search: () => search,
      replace: true,
    });
  }, [navigate, redirectToCanvases, search]);

  if (redirectToCanvases) return null;
  return <AdminOverview />;
}
