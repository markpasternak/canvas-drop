import { Link, useParams, useSearch } from "@tanstack/react-router";
import { StatusBadge } from "../components/Badge.js";
import { Skeleton } from "../components/Skeleton.js";
import { expiryLabel, formatBytes, fullTime, relativeTime } from "../lib/format.js";
import { useCanvas, useVersions } from "../lib/queries.js";

/** Friendly label for a deploy source (folder | zip | paste | api). */
function sourceLabel(source: string): string {
  return { folder: "folder upload", zip: "ZIP", paste: "paste", api: "the API" }[source] ?? source;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs uppercase tracking-wide text-subtle">{label}</dt>
      <dd className="text-sm text-fg">{children}</dd>
    </div>
  );
}

/** Overview tab: status, the live URL, and the current deploy at a glance. Shows
 * the one-time "Your canvas is live" annotation right after a first deploy. */
export default function Overview() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { live } = useSearch({ strict: false }) as { live?: boolean };
  const { data: canvas, isLoading } = useCanvas(id);
  const { data: versions } = useVersions(id);
  const current = versions?.find((v) => v.current);

  if (isLoading || !canvas) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {live && (
        <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-subtle px-4 py-3 text-sm text-success">
          <span className="size-2 rounded-full bg-current" aria-hidden />
          Your canvas is live. Share the link or deploy a new version anytime.
        </div>
      )}

      <dl className="grid gap-5 rounded-xl border border-border bg-surface p-5 sm:grid-cols-2">
        <Stat label="Status">
          <StatusBadge status={canvas.status} />
        </Stat>
        <Stat label="Visibility">
          {canvas.shared ? (
            <span>
              Shared{" "}
              {canvas.sharedExpiresAt && (
                <span className="text-muted">({expiryLabel(canvas.sharedExpiresAt)})</span>
              )}
            </span>
          ) : (
            "Private (owner only)"
          )}
          {canvas.hasPassword && <span className="text-muted"> · password-protected</span>}
          {canvas.galleryListed && <span className="text-muted"> · in gallery</span>}
        </Stat>
        <Stat label="Current deploy">
          {current ? (
            <span title={fullTime(current.createdAt)}>
              v{current.number} · via {sourceLabel(current.source)} ·{" "}
              {relativeTime(current.createdAt)} · {current.fileCount}{" "}
              {current.fileCount === 1 ? "file" : "files"} · {formatBytes(current.totalBytes)}
            </span>
          ) : (
            <span className="text-muted">Never deployed</span>
          )}
        </Stat>
        <Stat label="Deploys">
          {versions && versions.length > 0 ? (
            <Link
              to="/canvases/$id/versions"
              params={{ id }}
              className="text-accent hover:underline"
            >
              {versions.length} {versions.length === 1 ? "version" : "versions"}
            </Link>
          ) : (
            <span className="text-muted">None yet</span>
          )}
        </Stat>
        <Stat label="Created">
          <span title={fullTime(canvas.createdAt)}>{relativeTime(canvas.createdAt)}</span>
        </Stat>
      </dl>

      <div className="flex gap-2">
        <Link
          to="/canvases/$id/versions"
          params={{ id }}
          className="text-sm font-medium text-accent hover:underline"
        >
          View deploy history →
        </Link>
      </div>
    </div>
  );
}
