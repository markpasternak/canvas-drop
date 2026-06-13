import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { EmptyState } from "../components/EmptyState.js";
import { Skeleton } from "../components/Skeleton.js";
import { useToast } from "../components/Toast.js";
import { ApiError, type VersionInfo } from "../lib/api.js";
import { formatBytes, fullTime, relativeTime } from "../lib/format.js";
import { useRollback } from "../lib/mutations.js";
import { useVersions } from "../lib/queries.js";

/** Versions tab: deploy history (newest first) + one-click rollback. Rollback is
 * confirm-and-await (not optimistic) — it changes the live canvas for everyone. */
export default function Versions() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data: versions, isLoading, isError } = useVersions(id);
  const rollback = useRollback(id);
  const toast = useToast();
  const [target, setTarget] = useState<VersionInfo | null>(null);

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
        description="Deploy this canvas to see its history here."
      />
    );
  }

  async function confirmRollback() {
    if (!target) return;
    try {
      await rollback.mutateAsync(target.number);
      toast(`Rolled back to version ${target.number}`);
      setTarget(null);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Rollback failed", "error");
    }
  }

  return (
    <>
      <ul className="space-y-2">
        {versions.map((v) => (
          <li
            key={v.number}
            className="flex items-center gap-4 rounded-lg border border-border bg-surface px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium text-fg">v{v.number}</span>
                {v.current && <Badge tone="accent">Current</Badge>}
                <Badge tone="neutral">{v.source}</Badge>
              </div>
              <div className="mt-0.5 text-xs text-subtle" title={fullTime(v.createdAt)}>
                {relativeTime(v.createdAt)} · {v.fileCount} {v.fileCount === 1 ? "file" : "files"} ·{" "}
                {formatBytes(v.totalBytes)}
              </div>
            </div>
            {!v.current && v.status === "ready" && (
              <Button variant="secondary" size="sm" onClick={() => setTarget(v)}>
                Roll back
              </Button>
            )}
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        onConfirm={confirmRollback}
        title={`Roll back to version ${target?.number ?? ""}?`}
        actionLabel="Roll back"
        loading={rollback.isPending}
      >
        This replaces the live version for all visitors immediately. You can roll forward again from
        the history afterwards.
      </ConfirmDialog>
    </>
  );
}
