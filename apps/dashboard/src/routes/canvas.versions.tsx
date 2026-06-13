import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { TabContentFrame, TabEmptyState } from "../components/CanvasDetail.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { DeployButton } from "../components/DeployButton.js";
import { Skeleton } from "../components/Skeleton.js";
import { InlineNotice, Panel } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { ApiError, type VersionInfo } from "../lib/api.js";
import { formatBytes, fullTime, relativeTime } from "../lib/format.js";
import { useRestoreToDraft, useRollback } from "../lib/mutations.js";
import { useCanvas, useVersions } from "../lib/queries.js";

/** Versions tab: deploy history (newest first), forward "Deploy new version", and
 * per-version "Make live" (re-point the live version in either direction).
 * Confirm-and-await, not optimistic, since it changes the live canvas for all. */
export default function Versions() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data: versions, isLoading, isError } = useVersions(id);
  const { data: canvas } = useCanvas(id);
  const rollback = useRollback(id);
  const restore = useRestoreToDraft(id);
  const navigate = useNavigate();
  const toast = useToast();
  const [target, setTarget] = useState<VersionInfo | null>(null);
  // Deploy + make-live target the live canvas. Disabled while archived/disabled.
  const isActive = canvas?.status === "active";

  if (isLoading) {
    return (
      <TabContentFrame>
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </TabContentFrame>
    );
  }
  if (isError) {
    return <TabEmptyState title="Couldn't load versions" description="Please try again." />;
  }
  if (!versions || versions.length === 0) {
    return (
      <TabEmptyState
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

  async function restoreToDraft(version: number) {
    try {
      await restore.mutateAsync(version);
      toast(`Version ${version} loaded into the draft`);
      navigate({ to: "/canvases/$id/editor", params: { id } });
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't restore to the draft", "error");
    }
  }

  return (
    <TabContentFrame>
      <InlineNotice tone={isActive ? "neutral" : "warning"}>
        {versions.length} {versions.length === 1 ? "version" : "versions"}
        {isActive
          ? ". Deploy a new one from the button above."
          : ". Unarchive to deploy or change the live version."}
      </InlineNotice>

      <ul className="space-y-2">
        {versions.map((v) => (
          <li key={v.number}>
            <Panel className="flex items-center gap-4 p-4 sm:p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium text-fg">v{v.number}</span>
                  {v.current && <Badge tone="accent">Live</Badge>}
                  <Badge tone="neutral">{v.source}</Badge>
                </div>
                <div
                  className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-subtle"
                  title={fullTime(v.createdAt)}
                >
                  <span>{relativeTime(v.createdAt)}</span>
                  <span>
                    {v.fileCount} {v.fileCount === 1 ? "file" : "files"}
                  </span>
                  <span>{formatBytes(v.totalBytes)}</span>
                </div>
              </div>
              {v.status === "ready" && isActive && (
                <div className="flex flex-wrap justify-end gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => restoreToDraft(v.number)}
                    title="Load this version's files into the editable draft"
                  >
                    Restore to draft
                  </Button>
                  {!v.current && (
                    <Button variant="secondary" size="sm" onClick={() => setTarget(v)}>
                      Make live
                    </Button>
                  )}
                </div>
              )}
            </Panel>
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
    </TabContentFrame>
  );
}
