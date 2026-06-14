import { Link, Outlet, useParams } from "@tanstack/react-router";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { CanvasDetailChrome } from "../components/CanvasDetail.js";
import { DeployButton } from "../components/DeployButton.js";
import { EmptyState } from "../components/EmptyState.js";
import { Skeleton } from "../components/Skeleton.js";
import { useToast } from "../components/Toast.js";
import { ApiError } from "../lib/api.js";
import { useUnarchiveCanvas } from "../lib/mutations.js";
import { useCanvas } from "../lib/queries.js";

/** Canvas detail shell: breadcrumb back-affordance, header, routed tabs, Outlet. */
export default function CanvasLayout() {
  const { id } = useParams({ strict: false }) as { id: string };
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
        badge={
          canvas?.galleryTemplatable ? (
            <Badge tone="accent">Template</Badge>
          ) : canvas?.galleryListed ? (
            <Badge tone="neutral">Listed</Badge>
          ) : null
        }
      />

      {/* Every tab's content runs the full width of the shell (consistent across tabs). */}
      <Outlet />
    </div>
  );
}
