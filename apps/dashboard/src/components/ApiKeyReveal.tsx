import { Button } from "./Button.js";
import { CodeBox } from "./CodeBox.js";
import { Dialog } from "./Dialog.js";

/**
 * Shows a canvas secret key exactly once (§6.9.5). Keys are hashed at rest, so a
 * key the user doesn't save is unrecoverable, so the modal says so plainly. Dismiss
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
        <CodeBox value={apiKey} copy copyToast="Key copied" />
        <p className="text-xs text-muted">
          Lost it? You can regenerate the key in Settings. The old one stops working immediately.
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
