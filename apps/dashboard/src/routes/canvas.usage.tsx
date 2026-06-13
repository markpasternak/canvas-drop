import { useParams } from "@tanstack/react-router";
import { TabContentFrame } from "../components/CanvasDetail.js";
import { EmptyState } from "../components/EmptyState.js";
import { Skeleton } from "../components/Skeleton.js";
import { MetaGrid, MetaItem, Panel } from "../components/Surface.js";
import { formatBytes } from "../lib/format.js";
import { useCanvas, useUsage } from "../lib/queries.js";

/** Stats that light up in later milestones (per-visitor views = C/E). */
const COMING_SOON = ["Unique & total viewers"];

/** Compact USD: extra precision for small AI costs. */
function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** A metric value with an optional muted sub-line, matching the overview tab. */
function Metric({ value, sub }: { value: string; sub?: string }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-base font-semibold tracking-tight text-fg">{value}</span>
      {sub && <span className="text-muted">{sub}</span>}
    </span>
  );
}

/** Usage tab (D24): KV ops + file storage (M6), AI tokens/cost + realtime connects
 *  (M9), from usage_events / files / ai_usage. Per-visitor view stats remain "coming
 *  soon". Realtime is ephemeral, so we show connect count, not peak connections. */
export default function Usage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data: canvas, isLoading: canvasLoading } = useCanvas(id);
  // Only canvases with backend on have primitive usage; skip the query otherwise.
  const backendOn = canvas?.backendEnabled ?? false;
  const { data: usage, isLoading: usageLoading } = useUsage(id);

  if (canvasLoading || !canvas) {
    return (
      <TabContentFrame>
        <Skeleton className="h-40" />
      </TabContentFrame>
    );
  }

  if (!backendOn) {
    return (
      <EmptyState
        title="No backend usage yet"
        description={
          <span className="block">
            Turn on <strong>Backend</strong> in the Capabilities tab so this canvas can use KV,
            files, AI, and realtime — usage will appear here once it does.
          </span>
        }
      />
    );
  }

  if (usageLoading || !usage) {
    return (
      <TabContentFrame>
        <Skeleton className="h-40" />
      </TabContentFrame>
    );
  }

  return (
    <TabContentFrame>
      <Panel>
        <MetaGrid>
          <MetaItem label="KV operations">
            <Metric value={usage.kvOps.toLocaleString()} />
          </MetaItem>
          <MetaItem label="File storage">
            <Metric
              value={formatBytes(usage.fileBytes)}
              sub={`${usage.fileCount} file${usage.fileCount === 1 ? "" : "s"} · ${usage.fileOps.toLocaleString()} ops`}
            />
          </MetaItem>
          <MetaItem label="AI usage">
            <Metric
              value={formatUsd(usage.aiCostUsd)}
              sub={`${usage.aiTokens.toLocaleString()} tokens · ${usage.aiCalls.toLocaleString()} call${usage.aiCalls === 1 ? "" : "s"}`}
            />
          </MetaItem>
          <MetaItem label="Realtime connections">
            <Metric value={usage.realtimeConnects.toLocaleString()} sub="total connects" />
          </MetaItem>
        </MetaGrid>
      </Panel>

      <div className="space-y-2">
        <p className="text-[0.6875rem] font-medium text-subtle">Coming soon</p>
        <div className="flex flex-wrap gap-1.5">
          {COMING_SOON.map((m) => (
            <span
              key={m}
              className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-muted"
            >
              {m}
            </span>
          ))}
        </div>
      </div>
    </TabContentFrame>
  );
}
