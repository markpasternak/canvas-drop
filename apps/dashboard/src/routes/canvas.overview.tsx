import { Link, useParams, useSearch } from "@tanstack/react-router";
import { StatusBadge } from "../components/Badge.js";
import { Skeleton } from "../components/Skeleton.js";
import type { RootEntry } from "../lib/api.js";
import { expiryLabel, formatBytes, fullTime, relativeTime } from "../lib/format.js";
import { useCanvas, useVersions } from "../lib/queries.js";

/** Friendly label for a deploy source (folder | zip | paste | api). */
function sourceLabel(source: string): string {
  return { folder: "folder upload", zip: "ZIP", paste: "paste", api: "the API" }[source] ?? source;
}

/** The file served at the canvas root, or why nothing is. */
function EntryFile({ entry }: { entry: RootEntry }) {
  if (entry.path) {
    return (
      <span>
        <code className="text-[0.8125rem]">{entry.path}</code>
        {entry.reason === "single" && <span className="text-muted"> · no index.html</span>}
      </span>
    );
  }
  return (
    <span className="text-warning">
      {entry.reason === "ambiguous" ? "No index.html (multiple pages)" : "No HTML page"}
    </span>
  );
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
  // Total disk footprint = every kept (ready) version's bytes, not just the live one.
  const totalBytes = versions?.reduce((sum, v) => sum + v.totalBytes, 0) ?? 0;

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

      {current && current.entry.path === null && (
        <div className="rounded-lg border border-warning/40 bg-warning-subtle px-4 py-3 text-sm text-warning">
          {current.entry.reason === "ambiguous"
            ? "This deploy has no index.html and several pages, so the canvas root (your share link) won't load — there's no way to know which page is the home page. Rename your main page to index.html and deploy again."
            : "This deploy has no HTML page, so the canvas root won't load. Add an index.html and deploy again."}
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
              {relativeTime(current.createdAt)}
            </span>
          ) : (
            <span className="text-muted">Never deployed</span>
          )}
        </Stat>
        <Stat label="Size">
          {current ? (
            <span>
              {formatBytes(current.totalBytes)} · {current.fileCount}{" "}
              {current.fileCount === 1 ? "file" : "files"}
            </span>
          ) : (
            <span className="text-muted">—</span>
          )}
        </Stat>
        <Stat label="Entry file">
          {current ? <EntryFile entry={current.entry} /> : <span className="text-muted">—</span>}
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
        <Stat label="Total storage">
          <span title="Across all kept versions (newest 10)">
            {totalBytes > 0 ? formatBytes(totalBytes) : "—"}
          </span>
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
