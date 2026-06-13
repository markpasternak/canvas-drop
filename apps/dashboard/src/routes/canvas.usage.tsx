import { useParams } from "@tanstack/react-router";
import { EmptyState } from "../components/EmptyState.js";
import { Skeleton } from "../components/Skeleton.js";
import { formatBytes } from "../lib/format.js";
import { useCanvas, useUsage } from "../lib/queries.js";

/** Tiles that light up in later milestones (views = C/E, AI/realtime = M9). */
const COMING_SOON = ["Unique & total viewers", "AI tokens & cost", "Peak realtime connections"];

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-fg">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

/** Usage tab (D24, M6): real KV-op + file-storage figures from usage_events/files.
 *  View/AI/realtime tiles remain "coming soon" (later milestones). */
export default function Usage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data: canvas, isLoading: canvasLoading } = useCanvas(id);
  // Only canvases with backend on have primitive usage; skip the query otherwise.
  const backendOn = canvas?.backendEnabled ?? false;
  const { data: usage, isLoading: usageLoading } = useUsage(id);

  if (canvasLoading || !canvas) return <Skeleton className="h-48" />;

  if (!backendOn) {
    return (
      <EmptyState
        title="No backend usage yet"
        description={
          <span className="block">
            Turn on <strong>Backend</strong> in the Capabilities tab so this canvas can use KV and
            file storage — usage will appear here once it does.
          </span>
        }
      />
    );
  }

  if (usageLoading || !usage) return <Skeleton className="h-48" />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Stat label="KV operations" value={usage.kvOps.toLocaleString()} />
        <Stat
          label="File storage"
          value={formatBytes(usage.fileBytes)}
          sub={`${usage.fileCount} file${usage.fileCount === 1 ? "" : "s"} · ${usage.fileOps.toLocaleString()} ops`}
        />
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted">Coming soon</p>
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
    </div>
  );
}
