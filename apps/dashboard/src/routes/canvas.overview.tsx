import { Link, useParams, useSearch } from "@tanstack/react-router";
import { StatusBadge } from "../components/Badge.js";
import { TabContentFrame } from "../components/CanvasDetail.js";
import { Skeleton } from "../components/Skeleton.js";
import { InlineNotice, MetaGrid, MetaItem, Panel } from "../components/Surface.js";
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
        {entry.reason === "single" && <span className="text-muted"> (no index.html)</span>}
      </span>
    );
  }
  return (
    <span className="text-warning">
      {entry.reason === "ambiguous" ? "No index.html (multiple pages)" : "No HTML page"}
    </span>
  );
}

/**
 * Explains the canvas root when it's not the obvious index.html: reassures when
 * a lone file is being served as the home page, including the source,
 * and clearly warns when the root won't load at all. Nothing for the normal
 * index.html case.
 */
function EntryNotice({ entry, spaFallback }: { entry: RootEntry; spaFallback: boolean }) {
  if (entry.reason === "index") return null;

  if (entry.reason === "single") {
    return (
      <InlineNotice>
        No <code className="text-fg">index.html</code> in this deploy, so{" "}
        <code className="text-fg">{entry.path}</code> is being served as the home page. Your link
        works.
        {spaFallback && " Deep links resolve to it too (SPA fallback is on)."} Rename it to{" "}
        <code className="text-fg">index.html</code> to make the entry point explicit.
      </InlineNotice>
    );
  }

  return (
    <InlineNotice tone="warning">
      {entry.reason === "ambiguous" ? (
        <>
          This deploy has several pages but no <code>index.html</code>, so the canvas root (your
          share link) won't load. There is no way to know which page is the home page. Rename the
          main one to <code>index.html</code> and deploy again.
        </>
      ) : (
        <>
          This deploy has no HTML page, so the canvas root won't load. Add an{" "}
          <code>index.html</code> and deploy again.
        </>
      )}
    </InlineNotice>
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
      <TabContentFrame>
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </TabContentFrame>
    );
  }

  return (
    <TabContentFrame>
      {live && (
        <InlineNotice tone="success" className="flex items-center gap-2">
          Your canvas is live. Share the link or deploy a new version anytime.
        </InlineNotice>
      )}

      {current && <EntryNotice entry={current.entry} spaFallback={canvas.spaFallback} />}

      <Panel>
        <MetaGrid>
          <MetaItem label="Status">
            <StatusBadge status={canvas.status} />
          </MetaItem>
          <MetaItem label="Visibility">
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
            {canvas.hasPassword && <span className="text-muted">, password-protected</span>}
            {canvas.galleryListed && <span className="text-muted">, in gallery</span>}
          </MetaItem>
          <MetaItem label="Current deploy">
            {current ? (
              <span className="flex flex-wrap gap-x-3 gap-y-1" title={fullTime(current.createdAt)}>
                <span>v{current.number}</span>
                <span>via {sourceLabel(current.source)}</span>
                <span>{relativeTime(current.createdAt)}</span>
              </span>
            ) : (
              <span className="text-muted">Never deployed</span>
            )}
          </MetaItem>
          <MetaItem label="Size">
            {current ? (
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                <span>{formatBytes(current.totalBytes)}</span>
                <span>
                  {current.fileCount} {current.fileCount === 1 ? "file" : "files"}
                </span>
              </span>
            ) : (
              <span className="text-muted">None</span>
            )}
          </MetaItem>
          <MetaItem label="Entry file">
            {current ? (
              <EntryFile entry={current.entry} />
            ) : (
              <span className="text-muted">None</span>
            )}
          </MetaItem>
          <MetaItem label="Deploys">
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
          </MetaItem>
          <MetaItem label="Total storage">
            <span title="Across all kept versions (newest 10)">
              {totalBytes > 0 ? formatBytes(totalBytes) : "None"}
            </span>
          </MetaItem>
          <MetaItem label="Created">
            <span title={fullTime(canvas.createdAt)}>{relativeTime(canvas.createdAt)}</span>
          </MetaItem>
        </MetaGrid>
      </Panel>

      <div className="flex gap-2">
        <Link
          to="/canvases/$id/versions"
          params={{ id }}
          className="text-sm font-medium text-accent hover:underline"
        >
          View deploy history
        </Link>
      </div>
    </TabContentFrame>
  );
}
