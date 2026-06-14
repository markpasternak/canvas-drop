import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../components/Button.js";
import { CanvasRow, DefaultRowActions, ListSkeleton } from "../components/CanvasList.js";
import { CloneDialog } from "../components/CloneDialog.js";
import { EmptyState } from "../components/EmptyState.js";
import { PageHeader } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { ApiError, type CanvasListItem } from "../lib/api.js";
import { useArchiveCanvas } from "../lib/mutations.js";
import { useArchivedCanvases, useCanvases } from "../lib/queries.js";
import Onboarding from "./onboarding.js";

/** Active-list row: the usual copy/open, plus a calm one-click Archive (reversible —
 * the canvas moves to the Archived view, restorable anytime). */
function ActiveRow({ canvas }: { canvas: CanvasListItem }) {
  const toast = useToast();
  const archive = useArchiveCanvas(canvas.id);
  const [cloneOpen, setCloneOpen] = useState(false);
  return (
    <CanvasRow
      canvas={canvas}
      actions={
        <>
          <DefaultRowActions canvas={canvas} />
          <Button size="sm" variant="ghost" onClick={() => setCloneOpen(true)}>
            Duplicate
          </Button>
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
          <CloneDialog
            open={cloneOpen}
            onClose={() => setCloneOpen(false)}
            sourceId={canvas.id}
            sourceTitle={canvas.title}
            keepsPassword={canvas.hasPassword}
          />
        </>
      }
    />
  );
}

/** Shown when the active list is empty. A brand-new user gets the onboarding
 * first-run page; a user whose canvases are ALL archived gets a pointer to the
 * Archived view instead (showing "get started" would wrongly imply they have
 * nothing). The archived query only fires here — on the empty path — so it costs
 * nothing for users who have active canvases. */
function EmptyHome() {
  const { data: archived } = useArchivedCanvases();
  // Wait for the archived count before choosing, so we don't flash the full
  // onboarding page and then swap it for the archived pointer.
  if (archived === undefined) return <ListSkeleton />;
  if (archived.length > 0) {
    return (
      <EmptyState
        title="No active canvases"
        description={`All your canvases are archived (${archived.length}). Restore one to bring it back live, or create a new canvas.`}
        action={
          <Link to="/archived">
            <Button variant="secondary" size="sm">
              View archived
            </Button>
          </Link>
        }
      />
    );
  }
  return <Onboarding />;
}

/** My-canvases-first (§6.9.1). Zero canvases → onboarding, or a pointer to the
 * Archived view when every canvas is archived (see EmptyHome).
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

      {data && data.length === 0 && <EmptyHome />}

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
