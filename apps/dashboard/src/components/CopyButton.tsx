import type { Ref } from "react";
import { useState } from "react";
import { cn } from "../lib/cn.js";
import { useToast } from "./Toast.js";

/** Copy-to-clipboard affordance with confirmation (§6.9.7). Announces via the
 * toast live region. Falls back gracefully if the clipboard API is unavailable. */
export function CopyButton({
  value,
  label = "Copy",
  className,
  toastMessage = "Copied to clipboard",
  ref,
}: {
  value: string;
  label?: string;
  className?: string;
  toastMessage?: string;
  ref?: Ref<HTMLButtonElement>;
}) {
  const toast = useToast();
  const [done, setDone] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      toast(toastMessage);
      setTimeout(() => setDone(false), 1500);
    } catch {
      toast("Couldn't copy — copy it manually", "error");
    }
  }

  return (
    <button
      ref={ref}
      type="button"
      onClick={copy}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:bg-accent-subtle hover:text-accent",
        className,
      )}
    >
      {done ? "Copied" : label}
    </button>
  );
}
