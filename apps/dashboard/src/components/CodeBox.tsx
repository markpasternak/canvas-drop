import { cn } from "../lib/cn.js";
import { CopyButton } from "./CopyButton.js";

/**
 * A bordered `surface-sunken` mono block for code/secrets — the inline box
 * repeated in {@link ApiKeyReveal} and the new-canvas deploy panel, plus the
 * multiline deploy snippet.
 *
 * - `inline` (default): a single-line truncated value with an inline Copy
 *   button on the right (the shown-once secret-key box).
 * - `block`: a scrollable multiline `<pre>` (the curl snippet); no border, since
 *   it sits under its own labelled header with the copy control.
 *
 * `copy` adds a {@link CopyButton} (inline variant only); set `copyToast` for
 * the confirmation message.
 */
export function CodeBox({
  value,
  variant = "inline",
  copy = false,
  copyLabel = "Copy",
  copyToast = "Copied to clipboard",
  className,
}: {
  value: string;
  variant?: "inline" | "block";
  copy?: boolean;
  copyLabel?: string;
  copyToast?: string;
  className?: string;
}) {
  if (variant === "block") {
    return (
      <pre
        className={cn(
          "overflow-x-auto rounded-lg bg-surface-sunken p-4 font-mono text-xs text-muted",
          className,
        )}
      >
        {value}
      </pre>
    );
  }
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border border-border bg-surface-sunken p-3",
        className,
      )}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{value}</code>
      {copy && <CopyButton value={value} label={copyLabel} toastMessage={copyToast} />}
    </div>
  );
}
