import { useUnsavedChanges } from "../lib/use-unsaved-changes.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

/** Route-local drafts stay in memory until explicitly saved or discarded. */
export function PendingChangesGuard({ dirty }: { dirty: boolean }) {
  const blocker = useUnsavedChanges({ dirty });
  return (
    <ConfirmDialog
      open={blocker.status === "blocked"}
      onClose={() => blocker.reset?.()}
      onConfirm={() => blocker.proceed?.()}
      title="Leave with unsaved changes?"
      actionLabel="Discard and leave"
      destructive
    >
      Your changes have not been saved. Cancel to keep editing, or discard them to leave this page.
    </ConfirmDialog>
  );
}
