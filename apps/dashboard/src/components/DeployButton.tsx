import { useState } from "react";
import { ApiError } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { type DeployInput, useDeploy } from "../lib/mutations.js";
import { Button } from "./Button.js";
import { FileDropOrProgress } from "./DeployFiles.js";
import { Dialog } from "./Dialog.js";
import { TextareaField } from "./Field.js";
import { useToast } from "./Toast.js";

type Method = "paste" | "folder" | "zip";
const METHODS: { id: Method; label: string }[] = [
  { id: "paste", label: "Paste HTML" },
  { id: "folder", label: "Files or folder" },
  { id: "zip", label: "ZIP" },
];

/**
 * "Deploy new version" — opens a dialog that pushes a new version to an EXISTING
 * canvas (paste / folder / ZIP), the forward counterpart to the Versions tab's
 * "Make live". Self-contained: bundles the trigger, dialog, uploader, and the
 * deploy mutation (which invalidates the canvas + version queries on success).
 */
export function DeployButton({
  canvasId,
  variant = "primary",
  size = "sm",
  label = "Deploy new version",
}: {
  canvasId: string;
  variant?: "primary" | "secondary";
  size?: "sm" | "md";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<Method>("paste");
  const [html, setHtml] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const deploy = useDeploy(canvasId, (f) => setProgress(Math.round(f * 100)));
  const busy = deploy.isPending;

  function close() {
    if (busy) return;
    setOpen(false);
    setMethod("paste");
    setHtml("");
    setProgress(null);
    setError(null);
  }

  async function run(input: DeployInput) {
    setError(null);
    if (input.kind !== "paste") setProgress(0);
    try {
      const res = await deploy.mutateAsync(input);
      toast(`Deployed v${res.version}`);
      close();
    } catch (err) {
      setProgress(null);
      setError(err instanceof ApiError ? err.hint : "Deploy failed. Try again.");
    }
  }

  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={close}
        dismissable={!busy}
        title="Deploy a new version"
        description="Replaces the live canvas for everyone and adds to its version history."
      >
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-1.5">
            {METHODS.map((m) => (
              <button
                key={m.id}
                type="button"
                disabled={busy}
                onClick={() => {
                  setMethod(m.id);
                  setError(null);
                }}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors duration-100 [transition-timing-function:var(--ease-out)] disabled:opacity-50",
                  method === m.id
                    ? "border-accent bg-accent-subtle/50 text-fg"
                    : "border-border text-muted hover:border-border-strong",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>

          {error && (
            <div className="rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}

          {method === "paste" ? (
            <div className="space-y-3">
              <TextareaField
                label="HTML"
                mono
                rows={9}
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                placeholder="<!doctype html>\n<h1>Hello</h1>"
                data-autofocus
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  loading={busy}
                  disabled={!html.trim()}
                  onClick={() => run({ kind: "paste", html })}
                >
                  Deploy
                </Button>
              </div>
            </div>
          ) : method === "folder" ? (
            <FileDropOrProgress
              busy={busy}
              pct={progress}
              label="Drag files or a folder here"
              variant="folder"
              onFiles={(files) => run({ kind: "folder", files })}
            />
          ) : (
            <FileDropOrProgress
              busy={busy}
              pct={progress}
              label="Drag a .zip here"
              variant="zip"
              onFiles={(files) => {
                const file = files[0];
                if (file) run({ kind: "zip", file });
              }}
            />
          )}
        </div>
      </Dialog>
    </>
  );
}
