import { Link } from "@tanstack/react-router";
import { Badge, StatusBadge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { CopyButton } from "../components/CopyButton.js";
import { EmptyState } from "../components/EmptyState.js";
import { Skeleton } from "../components/Skeleton.js";
import type { CanvasListItem } from "../lib/api.js";
import { relativeTime } from "../lib/format.js";
import { useCanvases } from "../lib/queries.js";
import Onboarding from "./onboarding.js";

function LockIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden
    >
      <rect x="3.25" y="7" width="9.5" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

/** Row indicators. "Active" is the boring default — only badge what's notable:
 * a disabled (admin takedown) status, plus the access signals (shared, password).
 * A private, unprotected canvas shows no pills. */
function RowBadges({ canvas }: { canvas: CanvasListItem }) {
  return (
    <>
      {canvas.status !== "active" && <StatusBadge status={canvas.status} />}
      {canvas.shared && <Badge tone="accent">Shared</Badge>}
      {canvas.hasPassword && (
        <Badge tone="neutral">
          <LockIcon />
          Protected
        </Badge>
      )}
    </>
  );
}

function Row({ canvas }: { canvas: CanvasListItem }) {
  const title = canvas.title?.trim() || canvas.slug;
  return (
    <li className="group flex items-center gap-4 rounded-lg border border-border bg-surface px-4 py-3 transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:border-border-strong">
      <Link to="/canvases/$id" params={{ id: canvas.id }} className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-fg">{title}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <RowBadges canvas={canvas} />
          </span>
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
      {/* The dominant create action lives once, in the top bar (available on every
          page). No duplicate here. */}
      <h1 className="text-xl font-semibold tracking-tight">Your canvases</h1>

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
