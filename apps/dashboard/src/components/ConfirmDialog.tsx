import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { Field } from "./Field.js";

/**
 * Confirm a discrete action. Anatomy per the area-E conventions: a title, a
 * context slot, and a VERB-labeled action button (never "Confirm"/"OK"). The
 * `destructive` variant styles the action in the danger token, not the accent.
 *
 * `confirmPhrase` opts into type-to-confirm (Delete uses the canvas slug): the
 * action stays disabled until the typed value matches.
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
  confirmPhrase,
  confirmPhraseLabel,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  children?: ReactNode;
  actionLabel: string;
  destructive?: boolean;
  loading?: boolean;
  confirmPhrase?: string;
  confirmPhraseLabel?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  const phraseSatisfied = !confirmPhrase || typed.trim() === confirmPhrase;

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        {children && <div className="text-sm text-muted">{children}</div>}
        {confirmPhrase && (
          <Field
            label={
              confirmPhraseLabel ? String(confirmPhraseLabel) : `Type ${confirmPhrase} to confirm`
            }
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            mono
            autoComplete="off"
            spellCheck={false}
            data-autofocus
          />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            size="sm"
            onClick={onConfirm}
            loading={loading}
            disabled={!phraseSatisfied}
            data-autofocus={confirmPhrase ? undefined : true}
          >
            {actionLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
