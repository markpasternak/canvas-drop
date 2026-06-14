import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { TabContentFrame, TabEmptyState } from "../components/CanvasDetail.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { DeployButton } from "../components/DeployButton.js";
import { Skeleton } from "../components/Skeleton.js";
import { Panel } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { ApiError, type VersionInfo } from "../lib/api.js";
import { formatBytes, fullTime, relativeTime, sourceLabel } from "../lib/format.js";
import { useRestoreToDraft, useRollback } from "../lib/mutations.js";
import { useCanvas, useDraft, useVersions } from "../lib/queries.js";

/** Versions tab: version history (newest first), forward "Publish files", and
 * per-version "Make current" (re-point the served version in either direction).
 * Confirm-and-await, not optimistic, since it changes the live canvas for all. */
export default function Versions() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data: versions, isLoading, isError } = useVersions(id);
  const { data: canvas } = useCanvas(id);
  const { data: draft } = useDraft(id);
  const rollback = useRollback(id);
  const restore = useRestoreToDraft(id);
  const navigate = useNavigate();
  const toast = useToast();
  const [target, setTarget] = useState<VersionInfo | null>(null);
  // Version awaiting a "this overwrites your unpublished draft" confirmation.
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);
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
            ? "Publish files or publish the draft to start the version history."
            : "Unarchive this canvas to publish again."
        }
        action={isActive ? <DeployButton canvasId={id} label="Publish files" /> : undefined}
      />
    );
  }

  async function confirmMakeLive() {
    if (!target) return;
    try {
      await rollback.mutateAsync(target.number);
      toast(`Version ${target.number} is now current`);
      setTarget(null);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't change the current version", "error");
    }
  }

  // Restore replaces the draft wholesale. If the draft has unpublished changes, confirm
  // first so those edits aren't silently discarded; otherwise restore straight away.
  function requestRestore(version: number) {
    if (draft?.dirty) setRestoreTarget(version);
    else void restoreToDraft(version);
  }

  async function restoreToDraft(version: number) {
    try {
      await restore.mutateAsync(version);
      setRestoreTarget(null);
      toast(`Version ${version} loaded into the draft`);
      navigate({ to: "/canvases/$id/editor", params: { id } });
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't load into the draft", "error");
    }
  }

  return (
    <TabContentFrame>
      <Panel className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold text-fg">Version history</h2>
          <p className="text-xs text-muted">
            {versions.length} {versions.length === 1 ? "version" : "versions"} kept for this canvas.
            {isActive
              ? " Switch the current version or publish fresh files from here."
              : " Unarchive to publish or change the current version."}
          </p>
        </div>
        {isActive && <DeployButton canvasId={id} label="Publish files" variant="secondary" />}
      </Panel>

      <ul className="space-y-2">
        {versions.map((v) => (
          <li key={v.number}>
            <Panel className="flex items-center gap-4 p-4 sm:p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium text-fg">v{v.number}</span>
                  {v.current && <Badge tone="accent">Current</Badge>}
                  <Badge tone="neutral">{sourceLabel(v.source)}</Badge>
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
                    onClick={() => requestRestore(v.number)}
                    title="Load this version's files into the editable draft"
                  >
                    Edit this version
                  </Button>
                  {!v.current && (
                    <Button variant="secondary" size="sm" onClick={() => setTarget(v)}>
                      Make current
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
        title={`Make version ${target?.number ?? ""} current?`}
        actionLabel="Make current"
        loading={rollback.isPending}
      >
        This makes this version the current one for all visitors immediately. You can switch to any
        version in the history at any time.
      </ConfirmDialog>

      <ConfirmDialog
        open={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        onConfirm={() => restoreTarget !== null && restoreToDraft(restoreTarget)}
        title={`Load version ${restoreTarget ?? ""} into the draft?`}
        actionLabel="Load and discard changes"
        destructive
        loading={restore.isPending}
      >
        Your draft has unpublished changes. Loading this version's files into the draft discards
        those changes. The published version isn't affected until you publish.
      </ConfirmDialog>
    </TabContentFrame>
  );
}
