import { Link, useParams } from "@tanstack/react-router";
import { Button } from "../components/Button.js";
import { TabContentFrame } from "../components/CanvasDetail.js";
import { EmptyState } from "../components/EmptyState.js";
import { Section } from "../components/SettingsSection.js";
import { Skeleton } from "../components/Skeleton.js";
import { Sparkline } from "../components/Sparkline.js";
import { MetaGrid, MetaItem } from "../components/Surface.js";
import { formatBytes, formatUsd, relativeTime } from "../lib/format.js";
import { useCanvas, useUsage } from "../lib/queries.js";

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
  const { data: usage, isLoading: usageLoading, isError, refetch, dataUpdatedAt } = useUsage(id);
  const backendOn = canvas?.backendEnabled ?? false;

  if (isError) {
    return (
      <TabContentFrame>
        <EmptyState
          title="Couldn't load usage"
          description="We couldn't reach the usage stats just now. Try again."
          action={
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          }
        />
      </TabContentFrame>
    );
  }

  if (canvasLoading || !canvas || usageLoading || !usage) {
    return (
      <TabContentFrame>
        <Skeleton className="h-40" />
      </TabContentFrame>
    );
  }

  return (
    <TabContentFrame>
      <Section
        id="views"
        title="Views"
        description="This canvas only. Totals cover retained view events, normally up to 90 days after routine cleanup. Unique viewers counts signed-in accounts; anonymous visits have no unique identity. Repeated visits within the counting window are combined."
      >
        <p className="text-xs text-muted">Updated {new Date(dataUpdatedAt).toLocaleString()}</p>
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
        <div className="space-y-1.5">
          <p className="text-[0.6875rem] font-medium text-subtle">
            Last {usage.viewsByDay.length} days, including today
          </p>
          {usage.totalViews === 0 ? (
            <p className="text-xs text-muted">No views yet.</p>
          ) : (
            <Sparkline data={usage.viewsByDay} className="h-10 w-full text-accent" />
          )}
          <details className="pt-3 text-sm">
            <summary className="cursor-pointer font-medium text-fg">View daily values</summary>
            <table className="mt-3 w-full text-left text-sm tabular-nums">
              <caption className="mb-2 text-left text-xs text-muted">
                Views by UTC date over the last {usage.viewsByDay.length} days, including zero-view
                days. Today is partial.
              </caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="py-2">
                    Date (UTC)
                  </th>
                  <th scope="col" className="py-2 text-right">
                    Views
                  </th>
                </tr>
              </thead>
              <tbody>
                {usage.viewsByDay.map((day) => (
                  <tr key={day.dayMs} className="border-b border-border">
                    <th scope="row" className="py-2 font-normal">
                      <time dateTime={new Date(day.dayMs).toISOString().slice(0, 10)}>
                        {new Date(day.dayMs).toLocaleDateString(undefined, {
                          timeZone: "UTC",
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </time>
                    </th>
                    <td className="py-2 text-right">{day.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      </Section>

      <Section
        id="backend-usage"
        title="Backend usage"
        description="Operations, connections and AI usage cover retained events. File storage is the current amount stored, including uploads that predate the reporting window."
      >
        {backendOn ? (
          <MetaGrid>
            <MetaItem label="KV operations">
              <Metric value={usage.kvOps.toLocaleString()} />
            </MetaItem>
            <MetaItem label="File storage">
              <Metric
                value={formatBytes(usage.fileBytes)}
                sub={`${usage.fileCount} file${usage.fileCount === 1 ? "" : "s"}, ${usage.fileOps.toLocaleString()} ops`}
              />
            </MetaItem>
            <MetaItem label="AI usage">
              <Metric
                value={formatUsd(usage.aiCostUsd)}
                sub={`${usage.aiTokens.toLocaleString()} tokens, ${usage.aiCalls.toLocaleString()} call${usage.aiCalls === 1 ? "" : "s"}`}
              />
            </MetaItem>
            <MetaItem label="Realtime connections">
              <Metric value={usage.realtimeConnects.toLocaleString()} sub="total connects" />
            </MetaItem>
          </MetaGrid>
        ) : (
          <p className="text-sm text-muted">
            Turn on{" "}
            <Link
              to="/canvases/$id/capabilities"
              params={{ id }}
              className="font-medium text-accent underline"
            >
              Backend
            </Link>{" "}
            to use KV, files, AI, and realtime. Those usage figures will appear here once it does.
          </p>
        )}
      </Section>
    </TabContentFrame>
  );
}
