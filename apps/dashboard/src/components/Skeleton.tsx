import { cn } from "../lib/cn.js";

/** A shimmer placeholder. Callers size it to match the loaded content so the
 * swap causes no layout shift (§13.4 / §14.3). */
export function Skeleton({ className, label }: { className?: string; label?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-surface-sunken ring-1 ring-border", className)}
      aria-hidden={label ? undefined : true}
      role={label ? "status" : undefined}
    >
      {label && <span className="sr-only">{label}</span>}
    </div>
  );
}
