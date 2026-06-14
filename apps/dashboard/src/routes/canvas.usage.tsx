import { useParams } from "@tanstack/react-router";
import { TabContentFrame } from "../components/CanvasDetail.js";
import { Skeleton } from "../components/Skeleton.js";
import { Sparkline } from "../components/Sparkline.js";
import { MetaGrid, MetaItem, Panel } from "../components/Surface.js";
import { formatBytes, relativeTime } from "../lib/format.js";
import { useCanvas, useUsage } from "../lib/queries.js";

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

/** Usage tab (D24). Views (total, unique, last-viewed, 30-day sparkline) exist for
 *  every canvas and render unconditionally. Primitive usage — KV ops + file storage
 *  (M6), AI tokens/cost + realtime connects (M9) — only exists with a backend, so
 *  that panel is gated on `backendEnabled`. Realtime is ephemeral, so we show the
 *  connect count, not peak connections. */
export default function Usage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data: canvas, isLoading: canvasLoading } = useCanvas(id);
  // Views apply to all canvases, so the usage query always runs (KTD-5).
  const { data: usage, isLoading: usageLoading } = useUsage(id);
  const backendOn = canvas?.backendEnabled ?? false;

  if (canvasLoading || !canvas || usageLoading || !usage) {
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
          <MetaItem label="Total views">
            <Metric
              value={usage.totalViews.toLocaleString()}
              sub={`${usage.uniqueViewers.toLocaleString()} unique`}
            />
          </MetaItem>
          <MetaItem label="Last viewed">
            <Metric value={usage.lastViewedAt ? relativeTime(usage.lastViewedAt) : "Never"} />
          </MetaItem>
        </MetaGrid>
        <div className="mt-4 space-y-1.5">
          <p className="text-[0.6875rem] font-medium text-subtle">Last 30 days</p>
          {usage.totalViews === 0 ? (
            <p className="text-xs text-muted">No views yet.</p>
          ) : (
            <Sparkline data={usage.viewsByDay} className="h-10 w-full text-accent" />
          )}
        </div>
      </Panel>

      {backendOn ? (
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
      ) : (
        <p className="text-sm text-muted">
          Turn on <strong className="font-medium text-fg">Backend</strong> in the Capabilities tab
          to use KV, files, AI, and realtime — those usage figures will appear here once it does.
        </p>
      )}
    </TabContentFrame>
  );
}
