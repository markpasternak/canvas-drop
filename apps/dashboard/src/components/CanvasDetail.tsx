import { ArrowSquareOut } from "@phosphor-icons/react";
import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { CopyButton } from "./CopyButton.js";
import { EmptyState } from "./EmptyState.js";
import { IconLink } from "./IconButton.js";
import { Skeleton } from "./Skeleton.js";

const TABS = [
  { to: "/canvases/$id", label: "Overview", exact: true, path: (id: string) => `/canvases/${id}` },
  {
    to: "/canvases/$id/editor",
    label: "Edit",
    exact: false,
    path: (id: string) => `/canvases/${id}/editor`,
  },
  {
    to: "/canvases/$id/versions",
    label: "Versions",
    exact: false,
    path: (id: string) => `/canvases/${id}/versions`,
  },
  {
    to: "/canvases/$id/settings",
    label: "Settings",
    exact: false,
    path: (id: string) => `/canvases/${id}/settings`,
  },
  {
    to: "/canvases/$id/capabilities",
    label: "Capabilities",
    exact: false,
    path: (id: string) => `/canvases/${id}/capabilities`,
  },
  {
    to: "/canvases/$id/usage",
    label: "Usage",
    exact: false,
    path: (id: string) => `/canvases/${id}/usage`,
  },
] as const;

export function CanvasDetailChrome({
  id,
  title,
  url,
  isLoading,
  actions,
}: {
  id: string;
  title?: ReactNode;
  url?: string;
  isLoading?: boolean;
  actions?: ReactNode;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-panel)]">
      <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {isLoading ? (
            <Skeleton className="h-6 w-48" />
          ) : (
            <h1 className="truncate text-xl font-semibold tracking-tight text-fg">{title}</h1>
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

      <div className="overflow-x-auto border-t border-border px-3">
        {/* Section links (not ARIA tabs): they navigate routes and mark the current
            one with aria-current, the correct pattern for nav-style links. */}
        <nav className="flex w-max min-w-full gap-1" aria-label="Canvas sections">
          {TABS.map((tab) => {
            const tabPath = tab.path(id);
            const isActive = tab.exact ? pathname === tabPath : pathname.startsWith(tabPath);

            return (
              <Link
                key={tab.label}
                to={tab.to}
                params={{ id }}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative -mb-px border-b-2 px-3 py-3 text-sm font-medium transition-colors duration-100 [transition-timing-function:var(--ease-out)]",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                  isActive
                    ? "border-accent text-fg"
                    : "border-transparent text-muted hover:text-fg",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
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
