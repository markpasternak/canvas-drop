import { ArrowSquareOut, Circle } from "@phosphor-icons/react";
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
  draft,
  isLoading,
  actions,
  badge,
}: {
  id: string;
  title?: ReactNode;
  url?: string;
  /** True when the canvas is an unpublished draft — the header reframes around
   *  "Draft — not live yet" and stops presenting the URL as a live, reachable link. */
  draft?: boolean;
  isLoading?: boolean;
  actions?: ReactNode;
  /** Optional status pill rendered next to the title (e.g. gallery/template state). */
  badge?: ReactNode;
}) {
  return (
    <header>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          {isLoading ? (
            <Skeleton className="h-9 w-56" />
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
              <h1 className="truncate font-display text-h1 leading-tight text-fg">{title}</h1>
              {badge && <span className="shrink-0">{badge}</span>}
            </div>
          )}

          {isLoading ? (
            <Skeleton className="h-5 w-72" />
          ) : draft ? (
            // A draft has no reachable page — don't dangle the public URL as if it's
            // live. State the lifecycle plainly; the header actions (Open draft /
            // Publish) carry the way forward.
            <p className="flex items-center gap-1.5 text-sm text-muted">
              <Circle size={9} weight="fill" className="text-warning" aria-hidden />
              <span className="font-medium text-fg">Draft</span>
              <span aria-hidden>·</span>
              <span>not live yet — publish to make the URL reachable</span>
            </p>
          ) : !url ? (
            <Skeleton className="h-5 w-72" />
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate rounded-md font-mono text-xs text-accent hover:underline"
              >
                {url}
              </a>
              <CopyButton
                value={url}
                label="Copy"
                toastMessage="Link copied"
                className="h-7 px-1.5"
              />
              <IconLink href={url} target="_blank" rel="noreferrer" label="Open live canvas">
                <ArrowSquareOut size={15} weight="bold" aria-hidden />
              </IconLink>
            </div>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>

      <TabNav
        items={TABS.map((tab) => ({ ...tab, params: { id } }))}
        aria-label="Canvas sections"
        className="mt-4 border-b border-border"
      />
    </header>
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
