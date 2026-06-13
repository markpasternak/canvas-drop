import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";

/** Deliberate empty/placeholder state (§6.9.8, §14.3). Copy is always specific —
 * never a generic "Nothing here yet" (anti-slop). */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-surface/70 px-6 py-14 text-center",
        className,
      )}
    >
      {icon && <div className="text-subtle">{icon}</div>}
      <div className="space-y-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        {description && <p className="mx-auto max-w-sm text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
