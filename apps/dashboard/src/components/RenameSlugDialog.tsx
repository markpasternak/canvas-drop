import { useState } from "react";
import type { Me } from "../lib/api.js";
import type { SlugStatus } from "../lib/use-slug-availability.js";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { SlugField } from "./SlugField.js";

/**
 * Change a canvas's slug (plan 004, U7). Folds the "set your own" path into the
 * existing slug-regeneration action: an empty slug regenerates a random one (today's
 * behavior); a filled one renames to a custom slug. Unlike ConfirmDialog this needs a
 * form (to carry the typed value), so it composes the base Dialog directly.
 *
 * `onConfirm` receives the chosen slug (or `undefined` for random) and whether to keep
 * the current slug as a redirecting alias (plan 2026-10-30-1815). That defaults ON for a
 * custom rename (links keep working) and OFF for a random regenerate, which is the
 * "this URL leaked, rotate it" path. The consequence copy follows the choice.
 */
export function RenameSlugDialog({
  open,
  onClose,
  onConfirm,
  me,
  shared,
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (slug: string | undefined, keepOldAsAlias: boolean) => void;
  me: Me | undefined;
  /** Whether the canvas is shared — adds the "link you've shared" clause. */
  shared: boolean;
  loading?: boolean;
}) {
  const [resolved, setResolved] = useState<{ slug: string; status: SlugStatus }>({
    slug: "",
    status: "idle",
  });
  const blocked = resolved.slug !== "" && resolved.status !== "available";
  // null = follow the default for the current input (on for custom, off for random).
  const [keepChoice, setKeepChoice] = useState<boolean | null>(null);
  const keepOld = keepChoice ?? resolved.slug !== "";

  return (
    <Dialog open={open} onClose={onClose} title="Change the slug">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (blocked || loading) return;
          onConfirm(resolved.slug || undefined, keepOld);
        }}
      >
        <SlugField
          instance={me ? { urlMode: me.urlMode, baseUrl: me.baseUrl } : undefined}
          onResolved={setResolved}
          idleHint="Leave empty to generate a new random slug."
          autoFocus
        />
        <label className="flex items-start gap-2 text-sm text-fg">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={keepOld}
            onChange={(e) => setKeepChoice(e.target.checked)}
          />
          <span>
            Keep the current URL working
            <span className="block text-muted">
              It becomes an alias that redirects to the new URL.
            </span>
          </span>
        </label>
        <p className="text-sm text-muted">
          {keepOld ? (
            "Links to the current URL will redirect to the new one."
          ) : (
            <>
              The current URL will stop working
              {shared ? ", including the link you've shared with others" : ""}.
            </>
          )}{" "}
          Anyone viewing the canvas right now will be disconnected and will need to reload.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button size="sm" type="submit" loading={loading} disabled={blocked}>
            Change slug
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
