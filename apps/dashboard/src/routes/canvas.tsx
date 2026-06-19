import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { AccessBadge, GalleryBadge, PublicationBadge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { CanvasDetailChrome } from "../components/CanvasDetail.js";
import { DeployButton } from "../components/DeployButton.js";
import { EmptyState } from "../components/EmptyState.js";
import { Skeleton } from "../components/Skeleton.js";
import { useToast } from "../components/Toast.js";
import { ApiError, api } from "../lib/api.js";
import { isCanvasId } from "../lib/cosmetic-slug.js";
import { useUnarchiveCanvas } from "../lib/mutations.js";
import { useCanvas } from "../lib/queries.js";

/**
 * Resolve a non-id path param (a pasted cosmetic slug) to the canonical canvas id and
 * redirect to it (rebrand U17). A param shaped like a UUID is already canonical — we
 * never fire a lookup for it. Owner-scoped server-side; an unknown/non-owned slug
 * stays unresolved so the shell falls through to its not-found state (no leak).
 * Returns whether a redirect is pending so the caller can hold the not-found render.
 */
function useSlugRedirect(param: string): { resolving: boolean } {
  const navigate = useNavigate();
  const looksLikeId = isCanvasId(param);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const slugQuery = useQuery({
    queryKey: ["canvas-slug", param],
    queryFn: () => api.resolveSlug(param),
    enabled: !looksLikeId,
    retry: false,
  });

  const resolvedId = looksLikeId ? null : (slugQuery.data?.id ?? null);
  // Capture the sub-route once and fire the redirect a single time. `pathname` updates
  // as the router transitions, so keying the effect off it (or omitting the guard) would
  // re-issue navigate every render and loop the router. Reading it via a ref keeps the
  // sub-route current without making it a redirect trigger.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  // Latch on the *param we last redirected for*, not a bare boolean. A boolean
  // never resets within one CanvasLayout mount, so a second cosmetic-slug nav
  // (slug A → id → slug B) would early-return on the stale latch and strand the
  // user on the not-found skeleton. Keying off the param re-arms per slug.
  const redirectedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!resolvedId || redirectedForRef.current === param) return;
    redirectedForRef.current = param;
    // Preserve the sub-route (e.g. /editor, /share) when swapping slug → id.
    const rest = pathnameRef.current.slice(`/canvases/${param}`.length);
    void navigate({ to: `/canvases/${resolvedId}${rest}`, replace: true });
  }, [resolvedId, param, navigate]);

  if (looksLikeId) return { resolving: false };
  // Resolving while the lookup is in flight, or a match was found and the redirect
  // is queued — either way, hold the not-found render until we've left this route.
  return { resolving: slugQuery.isLoading || resolvedId !== null };
}

/** Canvas detail shell: breadcrumb back-affordance, header, routed tabs, Outlet. */
export default function CanvasLayout() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data: canvas, isLoading, isError } = useCanvas(id);
  const unarchive = useUnarchiveCanvas(id);
  const toast = useToast();
  // When `id` is actually a cosmetic slug, resolve it to the canonical id + redirect.
  const { resolving } = useSlugRedirect(id);

  if (isError && resolving) {
    // The id lookup 404'd because `id` is a slug; a redirect to the real id is in
    // flight (or the slug lookup is still settling). Hold a quiet skeleton rather
    // than flashing "not found" before the canonical route loads.
    return <Skeleton className="h-40 w-full" />;
  }

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
  // A live, active canvas is one that has actually been published (a current version
  // exists). An active canvas with no published version is a draft — not reachable at
  // its URL yet — so the header reframes around finishing it. Archived/disabled/deleted
  // keep their existing chrome and never get the draft treatment.
  const isDraft =
    canvas?.status === "active" &&
    (canvas.publicationState !== "published" || canvas.currentVersionId === null);
  const actions =
    canvas?.status === "active" ? (
      isDraft ? (
        // Draft: the two ways forward dominate — open the draft to keep editing, or
        // publish it live. No "New version" (there is no live version to replace yet).
        <>
          <Link
            to="/canvases/$id/editor"
            params={{ id }}
            className="inline-flex h-8 items-center justify-center whitespace-nowrap rounded-md border border-border-strong bg-surface-raised px-3 text-[0.8125rem] font-medium text-fg shadow-[var(--shadow-xs)] transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:bg-surface-hover"
          >
            Open draft
          </Link>
          <DeployButton canvasId={id} size="sm" label="Publish" />
        </>
      ) : (
        // Published: global "upload a new version" affordance — shown on every tab,
        // distinct from the Editor tab's own "Publish" (which publishes the draft).
        <DeployButton canvasId={id} size="sm" label="New version" />
      )
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
        draft={isDraft}
        isLoading={isLoading}
        actions={actions}
        badge={
          canvas ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <PublicationBadge state={canvas.publicationState} />
              <AccessBadge access={canvas.access} />
              <GalleryBadge canvas={canvas} />
            </span>
          ) : null
        }
      />

      {/* Every tab's content runs the full width of the shell (consistent across tabs). */}
      <Outlet />
    </div>
  );
}
