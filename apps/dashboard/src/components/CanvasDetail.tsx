import { ArrowSquareOut } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { CopyButton } from "./CopyButton.js";
import { EmptyState } from "./EmptyState.js";
import { IconLink } from "./IconButton.js";
import { Skeleton } from "./Skeleton.js";
import { TabNav, type TabNavItem } from "./TabNav.js";

const TABS: ReadonlyArray<Omit<TabNavItem, "params">> = [
  { to: "/canvases/$id", label: "Overview", end: true },
  { to: "/canvases/$id/editor", label: "Editor" },
  { to: "/canvases/$id/share", label: "Share" },
  { to: "/canvases/$id/versions", label: "Versions" },
  { to: "/canvases/$id/capabilities", label: "Backend" },
  { to: "/canvases/$id/usage", label: "Usage" },
  { to: "/canvases/$id/settings", label: "Settings" },
];

export function CanvasDetailChrome({
  id,
  title,
  url,
  isLoading,
  actions,
  badge,
}: {
  id: string;
  title?: ReactNode;
  url?: string;
  isLoading?: boolean;
  actions?: ReactNode;
  /** Optional status pill rendered next to the title (e.g. gallery/template state). */
  badge?: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-panel)]">
      <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {isLoading ? (
            <Skeleton className="h-6 w-48" />
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight text-fg">{title}</h1>
              {badge && <span className="shrink-0">{badge}</span>}
            </div>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>

      <div className="px-4 pb-4">
        {isLoading || !url ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2 py-1.5">
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate rounded-md font-mono text-xs text-accent hover:underline"
            >
              {url}
            </a>
            <CopyButton value={url} label="Copy" toastMessage="Link copied" className="h-8 px-2" />
            <IconLink href={url} target="_blank" rel="noreferrer" label="Open live canvas">
              <ArrowSquareOut size={15} weight="bold" aria-hidden />
            </IconLink>
          </div>
        )}
      </div>

      <TabNav
        items={TABS.map((tab) => ({ ...tab, params: { id } }))}
        aria-label="Canvas sections"
        className="border-t border-border px-3"
      />
    </section>
  );
}

// Every canvas tab runs the full width of the shell (consistent across tabs); a tab
// that wants a narrower column does so with its own className (e.g. Settings' grid).
export function TabContentFrame({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("space-y-4", className)}>{children}</div>;
}

export function TabEmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <TabContentFrame>
      <EmptyState
        title={title}
        description={description}
        action={action}
        className={cn("min-h-56", className)}
      />
    </TabContentFrame>
  );
}
