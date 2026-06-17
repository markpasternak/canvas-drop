import { useState } from "react";
import {
  type BulkResult,
  useBulkArchive,
  useBulkDelete,
  useBulkUnarchive,
} from "../lib/mutations.js";
import { Button } from "./Button.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { useToast } from "./Toast.js";

type Pending = "archive" | "unarchive" | "delete" | null;

/**
 * Contextual bulk-action toolbar for the Your-canvases list (§ owner multi-edit).
 * Appears only when ≥1 row is selected — the data-table pattern of a toolbar that
 * surfaces on selection rather than a permanent action column. Active rows can be
 * bulk-archived or deleted; archived rows unarchived or deleted. Each batch runs
 * the existing per-canvas endpoints (see useBulkLifecycle) and reports an aggregate
 * outcome; failures stay selected so the user can retry just those.
 */
export function BulkActionBar({
  selectedIds,
  scope,
  onClear,
  onResult,
}: {
  selectedIds: string[];
  scope: "active" | "archived";
  onClear: () => void;
  /** Hand back which ids settled which way so the page can keep failures selected. */
  onResult: (result: BulkResult) => void;
}) {
  const toast = useToast();
  const archive = useBulkArchive();
  const unarchive = useBulkUnarchive();
  const del = useBulkDelete();
  const [pending, setPending] = useState<Pending>(null);

  const count = selectedIds.length;
  const noun = count === 1 ? "canvas" : "canvases";
  const canvases = (n: number) => `${n} ${n === 1 ? "canvas" : "canvases"}`;

  async function run(
    mutate: (ids: string[]) => Promise<BulkResult>,
    verb: string,
    pastTense: string,
  ) {
    try {
      const result = await mutate(selectedIds);
      onResult(result);
      if (result.failed.length === 0) {
        toast(`${pastTense} ${canvases(result.succeeded.length)}`);
      } else if (result.succeeded.length === 0) {
        toast(`Couldn't ${verb} ${canvases(result.failed.length)}`, "error");
      } else {
        toast(
          `${pastTense} ${canvases(result.succeeded.length)} · ${result.failed.length} failed`,
          "error",
        );
      }
    } catch {
      toast(`Couldn't ${verb} the selected canvases`, "error");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-strong bg-surface-raised px-4 py-2.5 shadow-[var(--shadow-popover)]">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-fg">
          {count} {noun} selected
        </span>
        <button
          type="button"
          onClick={onClear}
          className="text-xs font-medium text-subtle transition-colors hover:text-fg"
        >
          Clear
        </button>
      </div>
      <div className="flex items-center gap-2">
        {scope === "active" ? (
          <Button size="sm" variant="secondary" onClick={() => setPending("archive")}>
            Archive
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            loading={unarchive.isPending}
            onClick={() => run(unarchive.mutateAsync, "unarchive", "Unarchived")}
          >
            Unarchive
          </Button>
        )}
        <Button size="sm" variant="danger" onClick={() => setPending("delete")}>
          Delete
        </Button>
      </div>

      <ConfirmDialog
        open={pending === "archive"}
        onClose={() => setPending(null)}
        onConfirm={() => run(archive.mutateAsync, "archive", "Archived")}
        title={`Archive ${count} ${noun}?`}
        actionLabel={`Archive ${count} ${noun}`}
        loading={archive.isPending}
      >
        They go offline and move to your Archived view, keeping their files, settings, and reserved
        URLs. You can restore them any time.
      </ConfirmDialog>

      <ConfirmDialog
        open={pending === "delete"}
        onClose={() => setPending(null)}
        onConfirm={() => run(del.mutateAsync, "delete", "Deleted")}
        title={`Delete ${count} ${noun}?`}
        actionLabel={`Delete ${count} ${noun}`}
        destructive
        holdToConfirm
        loading={del.isPending}
      >
        They go offline and leave your list. Recoverable for 30 days, then purged. Hold the button
        to confirm.
      </ConfirmDialog>
    </div>
  );
}
