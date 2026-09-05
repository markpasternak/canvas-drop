import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ApiError, api, type Canvas, type DraftView } from "../lib/api.js";
import { formatBytes } from "../lib/format.js";
import { usePublishDraft } from "../lib/mutations.js";
import { useMe } from "../lib/queries.js";
import { Button } from "./Button.js";
import { CanvasAudience } from "./CanvasAudience.js";
import { Dialog } from "./Dialog.js";
import { useToast } from "./Toast.js";

interface Review {
  canvas: Canvas;
  draft: DraftView;
}

/** Check content, its comparison baseline and audience again before submitting.
 * Publishing retains the existing server snapshot semantics; this is a review, not a lock. */
function fingerprint({ canvas, draft }: Review) {
  return JSON.stringify([
    draft.baseVersionId,
    draft.stale,
    draft.files
      .map(({ path, hash, size, mime }) => [path, hash, size, mime] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
    canvas.currentVersionId,
    canvas.status,
    canvas.access,
    canvas.orgId,
    canvas.publicLinkEnabled,
    canvas.hasPassword,
    canvas.sharedExpiresAt,
  ]);
}

const changeLabels = { added: "Added", modified: "Changed", deleted: "Removed" };

/** Mounted only while reviewing. A separate short-lived query keeps refreshes from
 * replacing the editor's file buffer, and never reuses a previous review on reopen. */
export function PublishReviewDialog({
  canvasId,
  onClose,
}: {
  canvasId: string;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["publish-review", canvasId],
    queryFn: async (): Promise<Review> => {
      const [draft, canvas] = await Promise.all([api.getDraft(canvasId), api.getCanvas(canvasId)]);
      return { draft, canvas };
    },
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const me = useMe().data;
  const publish = usePublishDraft(canvasId);
  const toast = useToast();
  const submitting = useRef(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const review = query.isError ? undefined : query.data;
  const busy = checking || query.isFetching || publish.isPending;
  const canPublish = !!review && review.canvas.status === "active" && review.draft.files.length > 0;

  async function confirmPublish() {
    if (!review || !canPublish || busy || submitting.current) return;
    submitting.current = true;
    setChecking(true);
    setError("");
    setNotice("");
    try {
      const latest = await query.refetch();
      if (latest.isError || !latest.data) return;
      if (fingerprint(review) !== fingerprint(latest.data)) {
        setNotice("The draft or its access changed. Review the updated details before publishing.");
        return;
      }
      const result = await publish.mutateAsync();
      toast(`Published version ${result.version}`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.hint : "The server response did not arrive.");
    } finally {
      submitting.current = false;
      setChecking(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={!checking && !publish.isPending}
      title="Review before publishing"
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted">
          Publishing makes the saved draft live at this canvas's link. You can recover an earlier
          version from Versions.
        </p>
        {query.isPending && (
          <p role="status" className="text-sm text-muted">
            Checking the saved draft…
          </p>
        )}
        {query.isError && (
          <div role="alert" className="space-y-2 text-sm text-danger">
            <p>
              Couldn't load the latest draft and access details. Refresh them before publishing.
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void query.refetch()}
              loading={query.isFetching}
            >
              Try again
            </Button>
          </div>
        )}
        {review && (
          <>
            <div className="border-y border-border py-3">
              <p className="text-sm font-medium text-fg">
                {review.draft.files.length} {review.draft.files.length === 1 ? "file" : "files"} ·{" "}
                {formatBytes(review.draft.files.reduce((total, file) => total + file.size, 0))}
              </p>
              {review.draft.entry?.path && (
                <p className="mt-1 text-xs text-muted">
                  Home page: <code className="break-all">{review.draft.entry.path}</code>
                </p>
              )}
              {review.draft.entry?.path === null && (
                <p className="mt-1 text-xs text-warning">
                  No home page is selected. Add index.html or keep a single HTML file so the canvas
                  link opens a page.
                </p>
              )}
            </div>
            {review.draft.stale && (
              <p className="text-sm text-warning">
                A newer version was published while this draft was being edited. Publishing replaces
                that version with this draft.
              </p>
            )}
            <section aria-label="File changes" className="space-y-2">
              <h3 className="text-xs font-semibold text-fg">Changes from the live version</h3>
              {review.draft.changes === undefined ? (
                <p className="text-xs text-muted">
                  Change details are unavailable on this server. Check the draft preview before
                  publishing.
                </p>
              ) : review.draft.changes.length === 0 ? (
                <p className="text-xs text-muted">No file changes from the live version.</p>
              ) : (
                <ul
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable changes need keyboard scrolling inside the focus-trapped dialog
                  tabIndex={0}
                  aria-label="Changed files"
                  className="max-h-44 overflow-y-auto overscroll-contain divide-y divide-border rounded-md border border-border"
                >
                  {review.draft.changes.map((change) => (
                    <li
                      key={change.path}
                      className="flex items-start justify-between gap-3 px-3 py-2 text-xs"
                    >
                      <code className="min-w-0 break-all text-fg">{change.path}</code>
                      <span className="shrink-0 text-muted">{changeLabels[change.kind]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="space-y-1.5" aria-label="Audience after publishing">
              <h3 className="text-xs font-semibold text-fg">Who can open after publishing</h3>
              <CanvasAudience
                canvas={review.canvas}
                orgs={me?.orgs}
                isGuest={me?.isGuest}
                afterPublish
              />
            </section>
            {review.draft.files.length === 0 && (
              <p role="alert" className="text-sm text-warning">
                This draft is empty. Add a file before publishing.
              </p>
            )}
          </>
        )}
        {notice && (
          <p role="status" className="text-sm text-warning">
            {notice}
          </p>
        )}
        {error && (
          <div role="alert" className="space-y-1 text-sm text-danger">
            <p>Publishing wasn't confirmed. {error}</p>
            <Link
              to="/canvases/$id/versions"
              params={{ id: canvasId }}
              onClick={onClose}
              className="font-medium underline"
            >
              Check Versions before retrying
            </Link>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={checking || publish.isPending}
          >
            Back to draft
          </Button>
          <Button
            size="sm"
            onClick={confirmPublish}
            disabled={!canPublish || busy}
            loading={checking || publish.isPending}
          >
            {query.data?.canvas.currentVersionId ? "Publish update" : "Publish canvas"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
