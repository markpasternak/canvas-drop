import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type AdminCanvasOperation, type AdminCanvasOperationResults, api } from "../lib/api.js";
import { formatBytes } from "../lib/format.js";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { Field, TextareaField } from "./Field.js";

export const ADMIN_OPERATION_LABELS: Record<AdminCanvasOperation, string> = {
  disable: "Disable",
  enable: "Enable",
  archive: "Archive",
  unarchive: "Unarchive",
  delete: "Delete",
  restore: "Restore",
  purge: "Permanently purge",
};
const EFFECTS: Record<AdminCanvasOperation, string> = {
  disable:
    "Take these canvases offline. Owners can see the recorded reason. Their data is retained.",
  enable: "Return disabled canvases to active status. Existing sharing rules apply again.",
  archive:
    "Take canvases offline and reset sharing and gallery listing. Data remains available for unarchiving.",
  unarchive:
    "Return archived canvases to active status. Owners must deliberately share them again.",
  delete:
    "Remove canvases from normal lists and take them offline. An admin can restore them until permanent purge starts. Admin purge becomes available after 30 days; operator maintenance may use a different retention policy.",
  restore: "Return deleted canvases to active status. Their existing sharing rules apply again.",
  purge:
    "Permanently remove all deployed versions, draft files, previews, uploaded files, stored app data, invitations and access grants. Keep the canvas identity and audit history. Other canvases remain intact. This cannot be undone or restored through the app.",
};

export function AdminCanvasOperationDialog({
  action,
  ids,
  onClose,
}: {
  action: AdminCanvasOperation;
  ids: string[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ["admin", "operation-preview", action, ids],
    queryFn: () => api.admin.previewCanvasOperation(action, ids),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const execute = useMutation({ mutationFn: api.admin.executeCanvasOperation });
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [results, setResults] = useState<AdminCanvasOperationResults | null>(null);
  const eligible =
    preview.data?.items.flatMap((item) =>
      item.eligible && item.updatedAt !== null ? [{ id: item.id, updatedAt: item.updatedAt }] : [],
    ) ?? [];
  const phrase = `${action.toUpperCase()} ${eligible.length}`;
  return (
    <Dialog
      placement="side"
      open
      onClose={onClose}
      dismissable={!execute.isPending}
      title={`${ADMIN_OPERATION_LABELS[action]} canvases`}
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">{EFFECTS[action]}</p>
        <p className="text-sm font-medium">
          Only the {ids.length} explicitly selected canvas{ids.length === 1 ? " is" : "es are"}{" "}
          included.
        </p>
        {action === "purge" && (
          <p className="text-sm text-muted">
            Eligible 30 days after deletion. If cleanup is interrupted, the canvas stays
            unavailable; review and retry the remaining cleanup.
          </p>
        )}
        {preview.isLoading && <p role="status">Preparing impact preview…</p>}
        {preview.isError && (
          <p role="alert">
            Could not prepare the preview.{" "}
            <Button variant="ghost" onClick={() => preview.refetch()}>
              Retry preview
            </Button>
          </p>
        )}
        {preview.data && (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {preview.data.items.map((item) => (
              <li key={item.id} className="space-y-1 p-3 text-sm">
                <p className="font-medium">{item.title}</p>
                <p className={item.eligible ? "text-muted" : "text-warning"}>
                  {item.eligible ? "Ready" : `Skipped: ${item.explanation}`}
                </p>
                {item.resources && (
                  <p className="text-xs text-muted">
                    {item.resources.versions} versions ({formatBytes(item.resources.versionBytes)}{" "}
                    before deduplication) · {item.resources.hasDraft ? "Draft present" : "No draft"}{" "}
                    · {item.resources.fileCount} uploaded files (
                    {formatBytes(item.resources.fileBytes)}) · {item.resources.kvRows} stored app
                    entries. {item.resources.storageObjects} actual storage files, including
                    previews and unused files, will be removed. Separate backups are unaffected.
                  </p>
                )}
                {item.resources?.eligibleAt && !item.eligible && (
                  <p className="text-xs text-subtle">
                    Retention ends {new Date(item.resources.eligibleAt).toLocaleString()}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {!results && eligible.length > 0 && (
          <>
            <TextareaField
              label="Reason for this operation"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={2}
            />
            <Field
              label={`Type ${phrase} to confirm`}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
            />
            {execute.isError && (
              <p role="alert" className="text-danger">
                The request failed. Some actions may have completed. Refresh the preview before
                retrying.
              </p>
            )}
            <Button
              variant="danger"
              loading={execute.isPending}
              disabled={
                !reason.trim() ||
                confirmation !== phrase ||
                preview.isFetching ||
                preview.isError ||
                execute.isError
              }
              onClick={async () => {
                try {
                  const result = await execute.mutateAsync({
                    action,
                    items: eligible,
                    reason: reason.trim(),
                    confirmation,
                  });
                  setResults(result);
                  void qc.invalidateQueries({ queryKey: ["admin"] });
                } catch {
                  /* The error state requires a fresh preview before retry. */
                }
              }}
            >
              {ADMIN_OPERATION_LABELS[action]} {eligible.length} selected
            </Button>
          </>
        )}
        {results && (
          <section aria-label="Operation results" className="space-y-2">
            <h3 className="font-semibold">Results</h3>
            <ul className="space-y-2 text-sm">
              {results.outcomes.map((outcome) => (
                <li key={outcome.id}>
                  <strong>
                    {preview.data?.items.find((item) => item.id === outcome.id)?.title ??
                      outcome.id}
                  </strong>
                  : {outcome.message}
                </li>
              ))}
            </ul>
          </section>
        )}
        {(results || execute.isError) && (
          <Button
            variant="secondary"
            onClick={async () => {
              setConfirmation("");
              setResults(null);
              execute.reset();
              await preview.refetch();
            }}
          >
            Refresh preview for another attempt
          </Button>
        )}
        <div className="flex justify-end">
          <Button variant="ghost" disabled={execute.isPending} onClick={onClose}>
            {results ? "Done" : "Cancel"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
