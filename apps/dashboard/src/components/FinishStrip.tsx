import { ArrowSquareOut, RocketLaunch } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { CanvasListItem } from "../lib/api.js";
import { Button } from "./Button.js";
import { canvasTitle, lastActivity } from "./CanvasList.js";

/** Threshold below which the library counts as "sparse" — a small, just-getting-
 *  started library where one canvas usually still wants finishing. */
const SPARSE_MAX_ACTIVE = 3;

/** Is this canvas still in the draft (not-yet-live) lifecycle? `publicationState` is
 *  the server-derived lifecycle truth: a draft is anything not yet "published" (its
 *  underlying mechanism is `currentVersionId === null`, but the derived state is the
 *  authoritative signal — a published canvas is never treated as a draft). The
 *  active-scope caller only passes active canvases, so archived/disabled/deleted
 *  states don't reach here in practice. */
function isDraft(canvas: CanvasListItem): boolean {
  return canvas.publicationState === "draft";
}

/**
 * Choose the single canvas to surface in the "finish this" strip, and decide
 * whether the library is sparse enough to show it at all.
 *
 * Sparse trigger (additive, condition-driven — there is no user dismiss):
 *   • the owner has ≤ 3 active canvases, OR
 *   • the most-recently-touched active canvas is still a draft.
 *
 * Surfaced canvas: the most-recently-touched DRAFT (the thing most likely to still
 * need finishing). If none is a draft, fall back to the most-recently-touched
 * canvas — but only when the library is small (≤ 3), so a large, healthy library of
 * published canvas never shows the strip.
 *
 * Returns `null` when the strip should be absent (dense library with nothing
 * unfinished, or an empty page — the caller also guards the zero / pristine state,
 * which Onboarding owns).
 */
export function pickFinishCanvas(
  canvases: CanvasListItem[],
  activeCount: number,
): CanvasListItem | null {
  // Most-recently-touched first, so "the most recent draft" and "the most recent
  // canvas" both fall out of the same ordering.
  const byRecency = [...canvases].sort((a, b) => lastActivity(b) - lastActivity(a));
  const mostRecent = byRecency[0];
  if (!mostRecent) return null;
  const mostRecentDraft = byRecency.find(isDraft) ?? null;

  const sparse = activeCount <= SPARSE_MAX_ACTIVE || isDraft(mostRecent);
  if (!sparse) return null;

  // Prefer the most-recent unfinished draft. With no draft, only surface a published
  // canvas while the library is still small — never on a large published library.
  if (mostRecentDraft) return mostRecentDraft;
  if (activeCount <= SPARSE_MAX_ACTIVE) return mostRecent;
  return null;
}

/** The single next step + its primary action for the surfaced canvas. A draft's one
 *  job is to go live; a published canvas's is to get shared. */
function nextStep(canvas: CanvasListItem): {
  status: string;
  step: string;
  primary: { label: string; to: "/canvases/$id/editor" | "/canvases/$id/share" };
} {
  if (isDraft(canvas)) {
    return {
      status: "Draft — not live yet",
      step: "Publish to get a live URL.",
      primary: { label: "Open draft", to: "/canvases/$id/editor" },
    };
  }
  return {
    status: "Published",
    step: "Share it to get it in front of people.",
    primary: { label: "Share", to: "/canvases/$id/share" },
  };
}

/**
 * U11 — the task-first "finish this canvas" strip. Additive: it rides ABOVE the
 * normal stats + filters + list when the library is sparse, surfacing exactly ONE
 * canvas with its single next step and primary action. It is condition-driven only
 * (no dismiss control): it disappears automatically once the library grows past the
 * sparse threshold and at the zero state (Onboarding owns that — the caller does not
 * render the strip with an empty library).
 *
 * On-brand: a quiet bordered panel (warm-paper/deep-navy surface, the same rounded
 * idiom as Panel) with a single accent action — not a loud banner.
 */
export function FinishStrip({ canvas }: { canvas: CanvasListItem }) {
  const title = canvasTitle(canvas);
  const { status, step, primary } = nextStep(canvas);
  const draft = isDraft(canvas);

  return (
    <section
      aria-label="Finish this canvas"
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-panel)] sm:flex-row sm:items-center sm:gap-5 sm:p-5"
    >
      <span
        className="flex size-10 shrink-0 items-center justify-center self-start rounded-lg bg-accent-subtle text-accent sm:self-center"
        aria-hidden
      >
        <RocketLaunch size={20} weight="duotone" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-subtle">
          Pick up where you left off
        </p>
        <p className="truncate font-medium text-fg">
          {title} <span className="font-normal text-subtle">· {status}</span>
        </p>
        <p className="text-sm text-muted">{step}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Link to={primary.to} params={{ id: canvas.id }}>
          <Button size="sm" variant="primary">
            {primary.label}
          </Button>
        </Link>
        {/* Secondary affordance: open a published canvas in a new tab; for a draft we
            keep a single primary (Open draft routes to the editor where Publish lives).
            A distinct accessible name (vs the row's "Open <title>") so the two never
            collide in a query / for a screen reader. */}
        {!draft && canvas.lastDeploy !== null && (
          <a
            href={canvas.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${title} in a new tab`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-fg"
          >
            Open
            <ArrowSquareOut size={13} weight="bold" aria-hidden />
          </a>
        )}
      </div>
    </section>
  );
}
