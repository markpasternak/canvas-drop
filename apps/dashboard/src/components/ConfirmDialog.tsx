import type { ReactNode } from "react";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { HoldButton } from "./HoldButton.js";

/**
 * Confirm a discrete action. Anatomy per the area-E conventions: a title, a
 * context slot, and a VERB-labeled action button (never "Confirm"/"OK"). The
 * `destructive` variant styles the action in the danger token, not the accent.
 *
 * One opt-in friction mode: `holdToConfirm` swaps the action for a
 * press-and-hold button — lighter friction for recoverable destructive actions.
 * (The old `confirmPhrase` type-to-confirm path was removed — the delete flow
 * switched to press-and-hold and no production caller uses it.)
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  actionLabel,
  destructive = false,
  loading = false,
  holdToConfirm = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  children?: ReactNode;
  actionLabel: string;
  destructive?: boolean;
  loading?: boolean;
  holdToConfirm?: boolean;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        {children && <div className="text-sm text-muted">{children}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          {holdToConfirm ? (
            <HoldButton onComplete={onConfirm} loading={loading}>
              {actionLabel}
            </HoldButton>
          ) : (
            <Button
              variant={destructive ? "danger" : "primary"}
              size="sm"
              onClick={onConfirm}
              loading={loading}
              data-autofocus
            >
              {actionLabel}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
