import { useState } from "react";
import type { AdminCanvasRow } from "../lib/api.js";
import { ApiError } from "../lib/api.js";
import { daysSince, formatBytes, relativeTime } from "../lib/format.js";
import {
  useAdminDisableCanvas,
  useAdminEnableCanvas,
  useAdminRestoreCanvas,
} from "../lib/mutations.js";
import { StatusBadge } from "./Badge.js";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { TextareaField } from "./Field.js";
import { useToast } from "./Toast.js";

/** Server cap on the takedown reason (routes/admin.ts disableBody.max). */
const REASON_MAX = 500;

/** Reason-capturing takedown dialog (§6.10.2 — the reason the owner later sees). */
function TakedownDialog({
  canvas,
  open,
  onClose,
}: {
  canvas: AdminCanvasRow;
  open: boolean;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const disable = useAdminDisableCanvas();
  const toast = useToast();
  return (
    <Dialog open={open} onClose={onClose} title={`Disable “${canvas.title || canvas.slug}”`}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          The public URL will show a “disabled” page. The owner sees the reason below in their
          dashboard.
        </p>
        <TextareaField
          label="Reason"
          placeholder="Why is this being taken down?"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
          maxLength={REASON_MAX}
          rows={3}
          hint={`${reason.length}/${REASON_MAX}`}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={disable.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={disable.isPending}
            disabled={reason.trim().length === 0}
            onClick={async () => {
              try {
                await disable.mutateAsync({ id: canvas.id, reason: reason.trim() });
                toast("Canvas disabled");
                onClose();
              } catch (err) {
                toast(err instanceof ApiError ? err.hint : "Couldn't disable", "error");
              }
            }}
          >
            Disable canvas
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RowActions({ canvas }: { canvas: AdminCanvasRow }) {
  const [takedownOpen, setTakedownOpen] = useState(false);
  const enable = useAdminEnableCanvas();
  const restore = useAdminRestoreCanvas();
  const toast = useToast();

  if (canvas.status === "active") {
    return (
      <>
        <Button size="sm" variant="secondary" onClick={() => setTakedownOpen(true)}>
          Disable
        </Button>
        <TakedownDialog
          canvas={canvas}
          open={takedownOpen}
          onClose={() => setTakedownOpen(false)}
        />
      </>
    );
  }
  if (canvas.status === "disabled") {
    return (
      <Button
        size="sm"
        variant="secondary"
        loading={enable.isPending}
        onClick={async () => {
          try {
            await enable.mutateAsync(canvas.id);
            toast("Canvas re-enabled");
          } catch (err) {
            toast(err instanceof ApiError ? err.hint : "Couldn't enable", "error");
          }
        }}
      >
        Enable
      </Button>
    );
  }
  if (canvas.status === "deleted") {
    return (
      <Button
        size="sm"
        variant="secondary"
        loading={restore.isPending}
        onClick={async () => {
          try {
            await restore.mutateAsync(canvas.id);
            toast("Canvas restored");
          } catch (err) {
            toast(err instanceof ApiError ? err.hint : "Couldn't restore", "error");
          }
        }}
      >
        Restore
      </Button>
    );
  }
  return null; // archived: owner-controlled, no admin action here
}

/** All-canvases table (§6.10.1) — owner / status / size / usage / last-activity. */
export function AdminCanvasTable({
  canvases,
  onOwnerClick,
}: {
  canvases: AdminCanvasRow[];
  onOwnerClick?: (owner: NonNullable<AdminCanvasRow["owner"]>) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="border-border border-b bg-surface-sunken text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Canvas</th>
            <th className="px-3 py-2 font-medium">Owner</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Size</th>
            <th className="px-3 py-2 text-right font-medium">Usage</th>
            <th className="px-3 py-2 font-medium">Last activity</th>
            <th className="px-3 py-2 font-medium" aria-label="Actions" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {canvases.map((c) => (
            <tr key={c.id} className="align-middle">
              <td className="px-3 py-2">
                <div className="font-medium text-fg">{c.title || c.slug}</div>
                <div className="font-mono text-xs text-muted">{c.slug}</div>
                {c.disabledReason && (
                  <div className="mt-0.5 text-xs text-danger">{c.disabledReason}</div>
                )}
                {c.status === "deleted" && c.deletedAt !== null && (
                  <div
                    className="mt-0.5 text-xs text-subtle"
                    title={`Deleted ${relativeTime(c.deletedAt)}`}
                  >
                    Deleted {daysSince(c.deletedAt)}d ago · awaiting purge
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-muted">
                {c.owner && onOwnerClick ? (
                  <button
                    type="button"
                    onClick={() => onOwnerClick?.(c.owner as NonNullable<AdminCanvasRow["owner"]>)}
                    className="rounded-md px-1 py-0.5 text-left text-accent transition-colors hover:bg-accent-subtle hover:underline"
                  >
                    {c.owner.email}
                  </button>
                ) : c.owner ? (
                  c.owner.email
                ) : (
                  "—"
                )}
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={c.status} />
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted">
                {formatBytes(c.sizeBytes)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted">
                {c.usageOps.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-muted">{relativeTime(c.lastActivityAt)}</td>
              <td className="px-3 py-2 text-right">
                <RowActions canvas={c} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
