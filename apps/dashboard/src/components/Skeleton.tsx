import { cn } from "../lib/cn.js";

/** A shimmer placeholder. Callers size it to match the loaded content so the
 * swap causes no layout shift (§13.4 / §14.3). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-border/70", className)} aria-hidden />;
}
