import { Link, Outlet, useParams } from "@tanstack/react-router";
import { CopyButton } from "../components/CopyButton.js";
import { DeployButton } from "../components/DeployButton.js";
import { EmptyState } from "../components/EmptyState.js";
import { Skeleton } from "../components/Skeleton.js";
import { cn } from "../lib/cn.js";
import { useCanvas } from "../lib/queries.js";

const TABS = [
  { to: "/canvases/$id", label: "Overview", exact: true },
  { to: "/canvases/$id/editor", label: "Edit", exact: false },
  { to: "/canvases/$id/versions", label: "Versions", exact: false },
  { to: "/canvases/$id/settings", label: "Settings", exact: false },
  { to: "/canvases/$id/usage", label: "Usage", exact: false },
] as const;

/** Canvas detail shell: breadcrumb back-affordance, header, routed tabs, Outlet. */
export default function CanvasLayout() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data: canvas, isLoading, isError } = useCanvas(id);

  if (isError) {
    return (
      <EmptyState
        title="Canvas not found"
        description="It may have been deleted, or you don't have access to it."
        action={
          <Link to="/" className="text-sm font-medium text-accent">
            ← Back to your canvases
          </Link>
        }
      />
    );
  }

  const title = canvas?.title?.trim() || canvas?.slug;

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1.5 text-sm text-subtle" aria-label="Breadcrumb">
        <Link to="/" className="hover:text-fg">
          Your canvases
        </Link>
        <span aria-hidden>/</span>
        {isLoading ? (
          <Skeleton className="h-4 w-28" />
        ) : (
          <span className="truncate font-medium text-fg">{title}</span>
        )}
      </nav>

      <header className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          {isLoading ? (
            <Skeleton className="h-7 w-48" />
          ) : (
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          )}
          {/* Deploy targets the live canvas — hidden while archived/disabled
              (the server also 409s these; this just keeps the UI coherent). */}
          {canvas?.status === "active" && <DeployButton canvasId={id} />}
        </div>
        {canvas && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <a
              href={canvas.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs text-accent hover:underline"
            >
              {canvas.url}
            </a>
            <CopyButton value={canvas.url} label="Copy" toastMessage="Link copied" />
            <a
              href={canvas.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-accent-subtle hover:text-accent"
            >
              Open
            </a>
          </div>
        )}
      </header>

      <div className="border-b border-border">
        <div className="flex gap-1" role="tablist">
          {TABS.map((tab) => (
            <Link
              key={tab.label}
              to={tab.to}
              params={{ id }}
              activeOptions={{ exact: tab.exact }}
              activeProps={{ "aria-current": "page" }}
              className={cn(
                "relative -mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-100 [transition-timing-function:var(--ease-out)]",
                "border-transparent text-muted hover:text-fg",
                "aria-[current=page]:border-accent aria-[current=page]:text-fg",
              )}
            >
              {tab.label}
            </Link>
          ))}
        </div>
      </div>

      <Outlet />
    </div>
  );
}
