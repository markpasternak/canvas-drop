import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, type VersionPrunePreview } from "../lib/api.js";
import { formatBytes } from "../lib/format.js";
import { keys } from "../lib/queries.js";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { useToast } from "./Toast.js";

export function VersionPruneDialog({
  canvasId,
  versions,
  onClose,
  onDeleted,
}: {
  canvasId: string;
  versions: number[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const preview = useQuery({
    queryKey: ["version-prune-preview", canvasId, versions],
    queryFn: () => api.previewVersionPrune(canvasId, versions),
    retry: false,
    // A confirmation describes one snapshot. Reopen to preview a new selection.
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const prune = useMutation({
    mutationFn: (selection: VersionPrunePreview) => api.pruneVersions(canvasId, selection),
    onSuccess: (result) => {
      const deleted = result.deleted.length;
      toast(
        `${deleted} ${deleted === 1 ? "version" : "versions"} deleted${result.skipped.length ? `. Kept ${result.skipped.map((s) => `v${s.version} (${s.reason.replaceAll("_", " ")})`).join(", ")}.` : ""}`,
      );
      onDeleted();
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.versions(canvasId) });
      qc.invalidateQueries({ queryKey: keys.draft(canvasId) });
    },
  });
  const error = preview.error ?? prune.error;
  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={!prune.isPending}
      title={
        versions.length === 1
          ? `Delete version ${versions[0]}?`
          : `Delete ${versions.length} versions?`
      }
    >
      <div className="space-y-4 text-sm text-muted">
        <p>
          This permanently removes the selected versions from history. You will no longer be able to
          restore them. Files still used by another version, the draft or an upload in progress are
          kept.
        </p>
        {preview.isPending && <p role="status">Calculating space that can be recovered…</p>}
        {preview.data && (
          <div className="space-y-2">
            <p>
              Versions to delete: {preview.data.versions.map((n) => `v${n}`).join(", ") || "None"}.
            </p>
            <p>
              <strong className="text-fg">
                {formatBytes(preview.data.estimatedReclaimableBytes)}
              </strong>{" "}
              estimated recoverable space. Shared files are counted once. Storage cleanup may finish
              later.
            </p>
            {preview.data.skipped.length > 0 && (
              <p>
                Kept:{" "}
                {preview.data.skipped
                  .map((s) => `v${s.version} (${s.reason.replaceAll("_", " ")})`)
                  .join(", ")}
                .
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error instanceof ApiError
              ? error.hint
              : "Couldn't complete cleanup. Refresh the preview and try again."}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={prune.isPending} onClick={onClose}>
            Cancel
          </Button>
          {error && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                prune.reset();
                preview.refetch();
              }}
            >
              Refresh preview
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            loading={prune.isPending}
            disabled={
              !preview.data?.versions.length ||
              preview.isFetching ||
              preview.isError ||
              prune.isError
            }
            onClick={() => preview.data && prune.mutate(preview.data)}
          >
            {versions.length === 1 ? "Delete version" : "Delete versions"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
