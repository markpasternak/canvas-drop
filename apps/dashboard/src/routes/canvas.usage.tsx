import { TabEmptyState } from "../components/CanvasDetail.js";

const METRICS = [
  "Unique & total viewers",
  "Last viewed",
  "KV operations",
  "File storage",
  "AI tokens & cost",
  "Peak realtime connections",
];

/** Usage tab — a deliberate, designed placeholder (§14.5). Usage analytics
 * (and the list sparkline) light up when the metering substrate and the canvas
 * primitives land. No network request. */
export default function Usage() {
  return (
    <TabEmptyState
      title="Usage analytics are coming soon"
      description={
        <span className="space-y-3 block">
          <span className="block">
            Once the canvas primitives are live, this tab will show how your canvas is used:
          </span>
          <span className="mx-auto flex max-w-md flex-wrap justify-center gap-1.5">
            {METRICS.map((m) => (
              <span
                key={m}
                className="rounded-md border border-border bg-surface-raised px-2.5 py-0.5 text-xs text-muted"
              >
                {m}
              </span>
            ))}
          </span>
        </span>
      }
    />
  );
}
