import { Button } from "./Button.js";
import { CopyButton } from "./CopyButton.js";
import { Dialog } from "./Dialog.js";

/**
 * Shows a canvas secret key exactly once (§6.9.5). Keys are hashed at rest, so a
 * key the user doesn't save is unrecoverable — the modal says so plainly. Dismiss
 * is explicit ("I've saved it"); leaving without saving forfeits the key
 * (recovery = regenerate). The key is never persisted client-side.
 */
export function ApiKeyReveal({ apiKey, onClose }: { apiKey: string; onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={false}
      title="Save your canvas key"
      description="This is the only time it's shown. Store it in a password manager or your deploy secrets."
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-canvas p-3">
          <code className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{apiKey}</code>
          <CopyButton value={apiKey} label="Copy" toastMessage="Key copied" />
        </div>
        <p className="text-xs text-muted">
          Lost it? You can regenerate the key in Settings — the old one stops working immediately.
        </p>
        <div className="flex justify-end">
          <Button size="sm" onClick={onClose} data-autofocus>
            I've saved it
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
