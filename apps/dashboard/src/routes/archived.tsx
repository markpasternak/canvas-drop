import { Link } from "@tanstack/react-router";
import { Button } from "../components/Button.js";
import { CanvasRow, ListSkeleton } from "../components/CanvasList.js";
import { CopyButton } from "../components/CopyButton.js";
import { EmptyState } from "../components/EmptyState.js";
import { PageHeader } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { ApiError, type CanvasListItem } from "../lib/api.js";
import { useUnarchiveCanvas } from "../lib/mutations.js";
import { useArchivedCanvases } from "../lib/queries.js";

/** A row in the archive view: the live URL 404s while archived, so the trailing
 * actions are Unarchive (restore it) + Copy (the slug is reserved), not Open. */
function ArchivedRow({ canvas }: { canvas: CanvasListItem }) {
  const toast = useToast();
  const unarchive = useUnarchiveCanvas(canvas.id);
  return (
    <CanvasRow
      canvas={canvas}
      actions={
        <>
          <CopyButton value={canvas.url} label="Copy link" toastMessage="Link copied" />
          <Button
            size="sm"
            variant="secondary"
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
        </>
      }
    />
  );
}

/** The Archive view (§6.9.1) — canvases the owner has taken offline. Reached via
 * the top-bar "Archived" nav. Restoring one returns it to the main list. */
export default function ArchivedList() {
  const { data, isLoading, isError, refetch } = useArchivedCanvases();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Archived"
        description="Offline canvases keep their files, settings, and reserved URLs until restored or deleted."
      />

      {isLoading && <ListSkeleton />}

      {isError && (
        <EmptyState
          title="Couldn't load your archived canvases"
          description="Something went wrong fetching the list."
          action={
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          }
        />
      )}

      {data && data.length === 0 && (
        <EmptyState
          title="Nothing archived"
          description="Archived canvases go offline but keep their files. Archive one from settings to retire it without deleting."
          action={
            <Link to="/" className="text-sm font-medium text-accent">
              Back to your canvases
            </Link>
          }
        />
      )}

      {data && data.length > 0 && (
        <ul className="space-y-2">
          {data.map((c) => (
            <ArchivedRow key={c.id} canvas={c} />
          ))}
        </ul>
      )}
    </div>
  );
}
