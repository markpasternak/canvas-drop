import type { Ref } from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.js";
import { useToast } from "./Toast.js";

/** Copy-to-clipboard affordance with confirmation (§6.9.7). Announces via the
 * toast live region. Falls back gracefully if the clipboard API is unavailable. */
export function CopyButton({
  value,
  label = "Copy",
  ariaLabel,
  className,
  toastMessage = "Copied to clipboard",
  onCopyFinished,
  ref,
}: {
  value: string;
  label?: string;
  ariaLabel?: string;
  className?: string;
  toastMessage?: string;
  /** Runs for the latest attempt while this value is still mounted. */
  onCopyFinished?: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new value invalidates pending clipboard feedback and confirmation
  useEffect(() => {
    setDone(false);
    return () => {
      sequence.current += 1;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value]);

  async function copy() {
    const request = ++sequence.current;
    if (timer.current) clearTimeout(timer.current);
    setDone(false);
    try {
      await navigator.clipboard.writeText(value);
      if (request !== sequence.current) return;
      setDone(true);
      toast(toastMessage);
      timer.current = setTimeout(() => setDone(false), 1500);
    } catch {
      if (request !== sequence.current) return;
      toast("Couldn't copy. Copy it manually.", "error");
    } finally {
      if (request === sequence.current) onCopyFinished?.();
    }
  }

  return (
    <button
      ref={ref}
      type="button"
      onClick={copy}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:bg-surface-hover hover:text-accent",
        className,
      )}
    >
      {done ? "Copied" : label}
    </button>
  );
}
