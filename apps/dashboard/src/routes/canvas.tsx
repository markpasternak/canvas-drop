import { Link, Outlet, useLocation, useParams } from "@tanstack/react-router";
import { Button } from "../components/Button.js";
import { CanvasDetailChrome } from "../components/CanvasDetail.js";
import { DeployButton } from "../components/DeployButton.js";
import { EmptyState } from "../components/EmptyState.js";
import { Skeleton } from "../components/Skeleton.js";
import { useToast } from "../components/Toast.js";
import { ApiError } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { useUnarchiveCanvas } from "../lib/mutations.js";
import { useCanvas } from "../lib/queries.js";

/**
 * Per-tab content width (UX: stable frame, content width varies by route). The app
 * shell + breadcrumb + tab chrome stay full-width (the constant); only the routed
 * body adapts: the editor is a full-bleed working surface, management tabs are a
 * centered reading column, and Settings is narrower still (forms read best narrow).
 */
function contentWidth(pathname: string): string {
  if (pathname.endsWith("/editor")) return ""; // full-bleed tool surface
  if (pathname.endsWith("/settings")) return "mx-auto w-full max-w-3xl"; // forms
  return "mx-auto w-full max-w-5xl"; // overview / versions / usage
}

/** Canvas detail shell: breadcrumb back-affordance, header, routed tabs, Outlet. */
export default function CanvasLayout() {
  const { id } = useParams({ strict: false }) as { id: string };
  const pathname = useLocation().pathname;
  const { data: canvas, isLoading, isError } = useCanvas(id);
  const unarchive = useUnarchiveCanvas(id);
  const toast = useToast();

  if (isError) {
    return (
      <EmptyState
        title="Canvas not found"
        description="It may have been deleted, or you don't have access to it."
        action={
          <Link to="/" className="text-sm font-medium text-accent">
            Back to your canvases
          </Link>
        }
      />
    );
  }

  const title = canvas?.title?.trim() || canvas?.slug;
  const actions =
    canvas?.status === "active" ? (
      <DeployButton canvasId={id} size="sm" label="Deploy new version" />
    ) : canvas?.status === "archived" ? (
      <Button
        size="sm"
        loading={unarchive.isPending}
        onClick={async () => {
          try {
            await unarchive.mutateAsync();
            toast("Canvas unarchived");
          } catch (err) {
            toast(err instanceof ApiError ? err.hint : "Couldn't unarchive", "error");
          }
        }}
      >
        Unarchive
      </Button>
    ) : null;

  return (
    <div className="space-y-4">
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

      <CanvasDetailChrome
        id={id}
        title={title}
        url={canvas?.url}
        isLoading={isLoading}
        actions={actions}
      />

      {/* Stable chrome above; the routed body sets its own width (Option A). */}
      <div className={cn(contentWidth(pathname))}>
        <Outlet />
      </div>
    </div>
  );
}
