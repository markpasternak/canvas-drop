import {
  ArrowRight,
  CheckCircle,
  CurrencyDollar,
  Globe,
  Prohibit,
  Trash,
  TrendUp,
} from "@phosphor-icons/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { AdminHeader } from "../components/AdminHeader.js";
import { Button } from "../components/Button.js";
import { CollapsibleSection } from "../components/CollapsibleSection.js";
import { EmptyState } from "../components/EmptyState.js";
import type { AdminOverview as AdminOverviewData } from "../lib/api.js";
import { daysSince, formatBytes, formatUsd } from "../lib/format.js";
import { useAdminAiUsage, useAdminOverview } from "../lib/queries.js";
import type { AdminCanvasesSearch } from "../router.js";

/** Purge-backlog age (days) past which the deleted lane reads as urgent vs routine. */
const PURGE_URGENT_DAYS = 30;

/**
 * A labelled metric. `strip` (default) is a bordered instrument-panel cell — cells
 * share one surface (gridlines come from the parent's gap), so the block reads as a
 * single panel, not a grid of SaaS hero-metric cards. `compact` is the borderless
 * inline variant. `emphasis` bumps the strip value size for the headline figures.
 */
function Metric({
  label,
  value,
  hint,
  variant = "strip",
  emphasis = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  variant?: "strip" | "compact";
  emphasis?: boolean;
}) {
  if (variant === "compact") {
    return (
      <div className="min-w-0">
        <dt className="text-[0.6875rem] font-medium text-subtle">{label}</dt>
        <dd className="mt-1 text-sm font-semibold text-fg tabular-nums">{value}</dd>
        {hint && <div className="mt-0.5 truncate text-xs text-subtle">{hint}</div>}
      </div>
    );
  }
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
            // Not a link: admins have no owner access to other people's canvases, so
            // the per-canvas detail page (/canvases/$id) 404s for them. This is a
            // read-only aggregate; moderation lives in the all-canvases table.
            <li
              key={r.key}
              className="flex items-center justify-between gap-3 px-4 py-2.5 text-muted"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-fg">{r.label}</span>
                {r.sub && <span className="block truncate text-xs text-subtle">{r.sub}</span>}
              </span>
              <span className="shrink-0 text-right tabular-nums">
                <span className="block font-medium text-fg">{formatUsd(r.costUsd)}</span>
                <span className="text-xs text-subtle">{r.calls.toLocaleString()} calls</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One operational signal in the "Needs attention" lane. A whole-row link to the
 * matching filtered admin table view. Urgency drives prominence — `urgent` rows
 * carry an amber accent + bolder count so they out-read the routine `info` rows;
 * we don't render every signal as an identical metric tile. Each row is built
 * from already-derivable data (no new backend).
 */
function AttentionRow({
  icon,
  label,
  detail,
  count,
  urgent = false,
  search,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  count: ReactNode;
  urgent?: boolean;
  search: AdminCanvasesSearch;
}) {
  return (
    <Link
      to="/admin/canvases"
      // Reset to page 1 with only the targeted filter (the route reads search
      // loosely; no validateSearch — mirror AdminUserTable's reducer form).
      search={() => ({ ...search, page: 1 })}
      className={
        urgent
          ? "group flex items-center gap-3 border-warning/40 border-l-2 bg-warning-subtle/30 px-4 py-3 transition-colors hover:bg-warning-subtle/50"
          : "group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-raised"
      }
    >
      <span className={urgent ? "shrink-0 text-warning" : "shrink-0 text-subtle"} aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-fg">{label}</span>
        {detail && <span className="block truncate text-xs text-subtle">{detail}</span>}
      </span>
      <span
        className={
          urgent
            ? "shrink-0 font-semibold text-base text-warning tabular-nums"
            : "shrink-0 font-semibold text-base text-fg tabular-nums"
        }
      >
        {count}
      </span>
      <ArrowRight
        size={15}
        className="shrink-0 text-subtle transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </Link>
  );
}

/**
 * Operational "needs attention" lane (plan U18). Assembled from derivable
 * signals — each links to the matching filtered admin canvases view. No trend
 * deltas, no screenshot-failure tracking (no backing data). The lane is ALWAYS
 * visible: when nothing is flagged it renders a calm all-clear state (so an admin
 * with a clean instance still sees the lane and learns what it watches), rather
 * than a row of zeroes or vanishing entirely.
 */
function NeedsAttention({
  overview,
  topSpender,
}: {
  overview: AdminOverviewData;
  topSpender: { title: string; ownerEmail: string | null; costUsd: number } | null;
}) {
  const byStatus = overview.canvasCountByStatus;
  const disabled = byStatus.disabled ?? 0;
  const deleted = byStatus.deleted ?? 0;
  const oldestDeletedDays =
    overview.oldestDeletedAt !== null ? daysSince(overview.oldestDeletedAt) : null;
  const topUsage = overview.topCanvases[0] ?? null;

  // Build only the rows that actually have something to surface.
  const rows: ReactNode[] = [];

  if (overview.publicLinkCount > 0) {
    rows.push(
      <AttentionRow
        key="public"
        icon={<Globe size={18} />}
        label="Public-link canvases"
        detail="Exposed beyond the org — review access"
        count={overview.publicLinkCount}
        urgent
        search={{ access: "public_link" }}
      />,
    );
  }

  if (deleted > 0) {
    const purgeUrgent = oldestDeletedDays !== null && oldestDeletedDays >= PURGE_URGENT_DAYS;
    rows.push(
      <AttentionRow
        key="deleted"
        icon={<Trash size={18} />}
        label="Awaiting purge"
        detail={
          oldestDeletedDays !== null
            ? `Oldest deleted ${oldestDeletedDays}d ago`
            : "Soft-deleted canvases"
        }
        count={deleted}
        urgent={purgeUrgent}
        search={{ status: "deleted" }}
      />,
    );
  }

  if (disabled > 0) {
    rows.push(
      <AttentionRow
        key="disabled"
        icon={<Prohibit size={18} />}
        label="Disabled canvases"
        detail="Taken down — showing a disabled page"
        count={disabled}
        search={{ status: "disabled" }}
      />,
    );
  }

  if (topSpender && topSpender.costUsd > 0) {
    rows.push(
      <AttentionRow
        key="spender"
        icon={<CurrencyDollar size={18} />}
        label="Top AI spender"
        detail={`${topSpender.title}${topSpender.ownerEmail ? ` · ${topSpender.ownerEmail}` : ""}`}
        count={formatUsd(topSpender.costUsd)}
        // Admins can't open other owners' detail pages (404); jump to the table
        // row by searching the title instead.
        search={{ q: topSpender.title }}
      />,
    );
  }

  if (topUsage) {
    rows.push(
      <AttentionRow
        key="usage"
        icon={<TrendUp size={18} />}
        label="Most active canvas"
        detail={topUsage.title || topUsage.slug || topUsage.canvasId}
        count={`${topUsage.ops.toLocaleString()} ops`}
        // Search by title/slug so the click lands on this canvas's table row.
        search={{ q: topUsage.title || topUsage.slug || topUsage.canvasId }}
      />,
    );
  }

  return (
    <CollapsibleSection title="Needs attention" storageKey="admin:section:attention" flush>
      {rows.length > 0 ? (
        <div className="divide-y divide-border bg-surface">{rows}</div>
      ) : (
        // All-clear: the lane is ALWAYS visible so an admin sees it (and learns what it
        // watches) even on a clean instance, rather than it vanishing entirely. A calm
        // confirmation + a one-line explainer of the signals it surfaces.
        <div className="flex items-start gap-3 bg-surface px-4 py-4">
          <CheckCircle
            size={20}
            weight="fill"
            className="mt-0.5 shrink-0 text-success"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="font-medium text-fg">Nothing needs attention right now</p>
            <p className="mt-0.5 text-xs text-subtle">
              This lane flags public-link exposure, disabled or deleted canvases, the purge backlog,
              the top AI spender, and the most-active canvas — so you see them the moment there's
              something to act on.
            </p>
          </div>
        </div>
      )}
    </CollapsibleSection>
  );
}

const CANVAS_SEARCH_KEYS: Array<keyof AdminCanvasesSearch> = [
  "owner",
  "status",
  "access",
  "templatable",
  "listed",
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
        title="Administration"
        description="Platform-wide visibility and governance health at a glance."
      />

      {/* Needs attention (plan U18) — operational lane from derivable signals,
          each linking to its filtered canvases view. Above the overview so the
          actionable things lead; always visible (all-clear state when nothing
          is flagged) so the lane's purpose is always discoverable. */}
      {ov && (
        <NeedsAttention
          overview={ov}
          topSpender={
            aiUsage.data?.byCanvas[0]
              ? {
                  title:
                    aiUsage.data.byCanvas[0].title ||
                    aiUsage.data.byCanvas[0].slug ||
                    aiUsage.data.byCanvas[0].canvasId,
                  ownerEmail: aiUsage.data.byCanvas[0].ownerEmail,
                  costUsd: aiUsage.data.byCanvas[0].costUsd,
                }
              : null
          }
        />
      )}

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
              <Metric label="Active canvases" value={byStatus.active ?? 0} emphasis />
              <Metric
                label="Signed-in users"
                value={ov.userCount}
                hint={ov.newUsers > 0 ? `+${ov.newUsers} in ${ov.recentWindowDays}d` : undefined}
                emphasis
              />
              <Metric label="Total views" value={ov.totalViews.toLocaleString()} emphasis />
              <Metric
                label="AI spend"
                value={formatUsd(ov.aiCostUsd)}
                hint={`${ov.aiCalls.toLocaleString()} calls`}
                emphasis
              />
            </dl>

            <dl className="grid gap-x-8 gap-y-4 border-border border-t px-4 py-3.5 sm:grid-cols-4 lg:grid-cols-8">
              <Metric
                variant="compact"
                label="Unique viewers"
                value={ov.uniqueViewers.toLocaleString()}
              />
              <Metric variant="compact" label="Deploys" value={ov.totalDeploys.toLocaleString()} />
              <Metric
                variant="compact"
                label="Primitive ops"
                value={ov.totalOps.toLocaleString()}
              />
              <Metric
                variant="compact"
                label="File storage"
                value={formatBytes(ov.totalFileBytes)}
              />
              <Metric
                variant="compact"
                label={`New (${ov.recentWindowDays}d)`}
                value={ov.newCanvases.toLocaleString()}
              />
              <Metric variant="compact" label="Disabled" value={byStatus.disabled ?? 0} />
              <Metric variant="compact" label="Archived" value={byStatus.archived ?? 0} />
              <Metric
                variant="compact"
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

      {/* Top canvases by usage — a read-only aggregate (most-active canvases by
          recorded ops). NOT clickable: admins have no owner access to other people's
          canvases, so the per-canvas detail page 404s for them; per-canvas moderation
          lives in the all-canvases table below. */}
      {ov && ov.topCanvases.length > 0 && (
        <CollapsibleSection title="Top canvases by usage" storageKey="admin:section:topCanvases">
          <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface-sunken/40 text-sm">
            {ov.topCanvases.slice(0, 5).map((t, index) => {
              const title = t.title || t.slug || t.canvasId;
              const meta = t.title && t.slug ? t.slug : t.canvasId;
              return (
                <li
                  key={t.canvasId}
                  className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 px-3 py-2.5"
                >
                  <span className="text-right text-xs text-subtle tabular-nums">{index + 1}</span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-fg">{title}</span>
                    <span className="block truncate text-xs text-subtle">{meta}</span>
                  </span>
                  <span className="shrink-0 text-sm text-muted tabular-nums">
                    {t.ops.toLocaleString()} ops
                  </span>
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
