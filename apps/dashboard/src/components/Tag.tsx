import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";

/** `xs` is the dense list-row chip (RowTags); `sm` is the gallery filter chip. */
type TagSize = "xs" | "sm";
/** `muted` is the default; `subtle` dims the row's "+N more" overflow chip. */
type TagTone = "muted" | "subtle";

const SIZES: Record<TagSize, string> = {
  xs: "rounded px-1.5 py-0.5 text-[0.6875rem]",
  sm: "rounded-md px-2 py-0.5 text-xs",
};

const TONES: Record<TagTone, string> = {
  muted: "text-muted",
  subtle: "text-subtle",
};

/**
 * A small chip on the shared `surface-sunken` recipe — the ad-hoc tag pills from
 * the list rows ({@link CanvasList} RowTags) and the gallery filter buttons,
 * unified. A bare display chip by default; pass `onClick` to render it as a
 * `<button>` (the clickable gallery variant) with a hover affordance.
 */
export function Tag({
  children,
  size = "xs",
  tone = "muted",
  onClick,
  title,
  className,
}: {
  children: ReactNode;
  size?: TagSize;
  tone?: TagTone;
  onClick?: () => void;
  title?: string;
  className?: string;
}) {
  const base = cn(
    "inline-flex items-center border border-border bg-surface-sunken font-medium",
    SIZES[size],
    TONES[tone],
    className,
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={cn(
          base,
          "transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:text-fg",
        )}
      >
        {children}
      </button>
    );
  }
  return (
    <span title={title} className={base}>
      {children}
    </span>
  );
}
