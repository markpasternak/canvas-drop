import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { DeployButton } from "../components/DeployButton.js";
import { EmptyState } from "../components/EmptyState.js";
import { Skeleton } from "../components/Skeleton.js";
import { useToast } from "../components/Toast.js";
import { ApiError, type VersionInfo } from "../lib/api.js";
import { formatBytes, fullTime, relativeTime } from "../lib/format.js";
import { useRollback } from "../lib/mutations.js";
import { useCanvas, useVersions } from "../lib/queries.js";

/** Versions tab: deploy history (newest first), forward "Deploy new version", and
 * per-version "Make live" (re-point the live version in either direction —
 * confirm-and-await, not optimistic, since it changes the live canvas for all). */
export default function Versions() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data: versions, isLoading, isError } = useVersions(id);
  const { data: canvas } = useCanvas(id);
  const rollback = useRollback(id);
  const toast = useToast();
  const [target, setTarget] = useState<VersionInfo | null>(null);
  // Deploy + make-live target the live canvas — disabled while archived/disabled.
  const isActive = canvas?.status === "active";

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    );
  }
  if (isError) {
    return <EmptyState title="Couldn't load versions" description="Please try again." />;
  }
  if (!versions || versions.length === 0) {
    return (
      <EmptyState
        title="No versions yet"
        description={
          isActive
            ? "Deploy this canvas to see its history here."
            : "Unarchive this canvas to deploy and start its history."
        }
        action={isActive ? <DeployButton canvasId={id} /> : undefined}
      />
    );
  }

  async function confirmMakeLive() {
    if (!target) return;
    try {
      await rollback.mutateAsync(target.number);
      toast(`Version ${target.number} is now live`);
      setTarget(null);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't change the live version", "error");
    }
  }

  return (
    <>
      <p className="mb-4 text-sm text-muted">
        {versions.length} {versions.length === 1 ? "version" : "versions"}
        {isActive
          ? " · deploy a new one from the button above."
          : " · unarchive to deploy or change the live version."}
      </p>

      <ul className="space-y-2">
        {versions.map((v) => (
          <li
            key={v.number}
            className="flex items-center gap-4 rounded-lg border border-border bg-surface px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium text-fg">v{v.number}</span>
                {v.current && <Badge tone="accent">Live</Badge>}
                <Badge tone="neutral">{v.source}</Badge>
              </div>
              <div className="mt-0.5 text-xs text-subtle" title={fullTime(v.createdAt)}>
                {relativeTime(v.createdAt)} · {v.fileCount} {v.fileCount === 1 ? "file" : "files"} ·{" "}
                {formatBytes(v.totalBytes)}
              </div>
            </div>
            {!v.current && v.status === "ready" && isActive && (
              <Button variant="secondary" size="sm" onClick={() => setTarget(v)}>
                Make live
              </Button>
            )}
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        onConfirm={confirmMakeLive}
        title={`Make version ${target?.number ?? ""} live?`}
        actionLabel="Make live"
        loading={rollback.isPending}
      >
        This replaces the live version for all visitors immediately. You can switch to any version
        in the history at any time.
      </ConfirmDialog>
    </>
  );
}
