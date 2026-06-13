import { Link } from "@tanstack/react-router";
import { StatusBadge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { CopyButton } from "../components/CopyButton.js";
import { EmptyState } from "../components/EmptyState.js";
import { Skeleton } from "../components/Skeleton.js";
import type { CanvasListItem } from "../lib/api.js";
import { relativeTime } from "../lib/format.js";
import { useCanvases } from "../lib/queries.js";
import Onboarding from "./onboarding.js";

function Row({ canvas }: { canvas: CanvasListItem }) {
  const title = canvas.title?.trim() || canvas.slug;
  return (
    <li className="group flex items-center gap-4 rounded-lg border border-border bg-surface px-4 py-3 transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:border-border-strong">
      <Link to="/canvases/$id" params={{ id: canvas.id }} className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{title}</span>
          <StatusBadge status={canvas.status} />
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-subtle">
          <span className="truncate font-mono">{canvas.slug}</span>
          <span aria-hidden>·</span>
          <span>
            {canvas.lastDeploy
              ? `v${canvas.lastDeploy.version} · ${relativeTime(canvas.lastDeploy.createdAt)}`
              : "Never deployed"}
          </span>
        </div>
      </Link>
      <div className="flex shrink-0 items-center gap-1">
        <CopyButton value={canvas.url} label="Copy link" toastMessage="Link copied" />
        <a
          href={canvas.url}
          target="_blank"
          rel="noreferrer"
          className="rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:bg-accent-subtle hover:text-accent"
        >
          Open
        </a>
      </div>
    </li>
  );
}

function ListSkeleton() {
  return (
    <ul className="space-y-2" aria-hidden>
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="flex items-center gap-4 rounded-lg border border-border bg-surface px-4 py-3"
        >
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-6 w-20" />
        </li>
      ))}
    </ul>
  );
}

/** My-canvases-first (§6.9.1). Zero canvases → the onboarding first-run page. */
export default function CanvasList() {
  const { data, isLoading, isError, refetch } = useCanvases();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Your canvases</h1>
        <Link
          to="/new"
          className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:bg-accent-hover"
        >
          Create canvas
        </Link>
      </div>

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
            <Row key={c.id} canvas={c} />
          ))}
        </ul>
      )}
    </div>
  );
}
