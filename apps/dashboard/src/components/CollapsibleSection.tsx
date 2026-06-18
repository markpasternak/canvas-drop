import { CaretRight } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { cn } from "../lib/cn.js";

/** Read a persisted open/closed flag, falling back when storage is unavailable
 *  (private mode, disabled storage) — mirrors the theme toggle's try/catch guard. */
function readStored(key: string, fallback: boolean): boolean {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

/**
 * A titled, collapsible panel whose open/closed state persists in localStorage
 * (keyed by `storageKey`). Tames the admin overview's vertical density: detail
 * sections fold away so the canvas governance table stays reachable, and each
 * section remembers how the admin left it across sessions. Best-effort storage —
 * a write failure just means the preference isn't remembered, never an error.
 */
export function CollapsibleSection({
  title,
  storageKey,
  defaultOpen = true,
  flush = false,
  children,
}: {
  title: ReactNode;
  storageKey: string;
  defaultOpen?: boolean;
  /** Drop body padding and add a divider — for edge-to-edge content like a stat grid. */
  flush?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readStored(storageKey, defaultOpen));
  const regionId = `${storageKey}-region`;

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, open ? "1" : "0");
    } catch {
      // persistence is best-effort — ignore storage failures
    }
  }, [storageKey, open]);

  return (
    <section className="border-border border-b">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={regionId}
        className="flex w-full items-center gap-2 py-3 text-left transition-colors hover:text-accent"
      >
        <CaretRight
          size={14}
          weight="bold"
          aria-hidden
          className={cn("text-muted transition-transform duration-150", open && "rotate-90")}
        />
        <span className="text-sm font-semibold text-fg">{title}</span>
      </button>
      {/* Always render the region (toggle visibility with `hidden`) so the button's
          aria-controls always references a present element — a collapsed disclosure
          that points at a missing id is an invalid ARIA contract. */}
      <div id={regionId} hidden={!open} className={cn(flush ? "border-t border-border" : "pb-4")}>
        {children}
      </div>
    </section>
  );
}
