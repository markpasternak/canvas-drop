import { Button } from "../components/Button.js";
import { CanvasRow, DefaultRowActions, ListSkeleton } from "../components/CanvasList.js";
import { EmptyState } from "../components/EmptyState.js";
import { PageHeader } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { ApiError, type CanvasListItem } from "../lib/api.js";
import { useArchiveCanvas } from "../lib/mutations.js";
import { useCanvases } from "../lib/queries.js";
import Onboarding from "./onboarding.js";

/** Active-list row: the usual copy/open, plus a calm one-click Archive (reversible —
 * the canvas moves to the Archived view, restorable anytime). */
function ActiveRow({ canvas }: { canvas: CanvasListItem }) {
  const toast = useToast();
  const archive = useArchiveCanvas(canvas.id);
  return (
    <CanvasRow
      canvas={canvas}
      actions={
        <>
          <DefaultRowActions canvas={canvas} />
          <Button
            size="sm"
            variant="ghost"
            loading={archive.isPending}
            onClick={async () => {
              try {
                await archive.mutateAsync();
                toast("Canvas archived");
              } catch (err) {
                toast(err instanceof ApiError ? err.hint : "Couldn't archive", "error");
              }
            }}
          >
            Archive
          </Button>
        </>
      }
    />
  );
}

/** My-canvases-first (§6.9.1). Zero canvases → the onboarding first-run page.
 * Archived canvases live in their own view (/archived) and are excluded here. */
export default function CanvasList() {
  const { data, isLoading, isError, refetch } = useCanvases();

  return (
    <div className="space-y-6">
      {/* The dominant create action lives once, in the top bar (available on every
          page). No duplicate here. */}
      <PageHeader
        title="Your canvases"
        description="Manage drafts, published versions, sharing, and settings from one place."
      />

      {isLoading && <ListSkeleton />}

      {isError && (
        <EmptyState
          title="Couldn't load your canvases"
          description="Something went wrong fetching the list."
          action={
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          }
        />
      )}

      {data && data.length === 0 && <Onboarding />}

      {data && data.length > 0 && (
        <ul className="space-y-2">
          {data.map((c) => (
            <ActiveRow key={c.id} canvas={c} />
          ))}
        </ul>
      )}
    </div>
  );
}
