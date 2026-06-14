import { ArrowSquareOut, CheckCircle, Info, WarningCircle } from "@phosphor-icons/react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { StatusBadge } from "../components/Badge.js";
import { TabContentFrame } from "../components/CanvasDetail.js";
import { CopyButton } from "../components/CopyButton.js";
import { DeployButton } from "../components/DeployButton.js";
import { IconLink } from "../components/IconButton.js";
import { Skeleton } from "../components/Skeleton.js";
import { InlineNotice, Panel } from "../components/Surface.js";
import type { Canvas, RootEntry, VersionInfo } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { expiryLabel, formatBytes, fullTime, relativeTime, sourceLabel } from "../lib/format.js";
import { useCanvas, useVersions } from "../lib/queries.js";

function rootWorks(entry?: RootEntry): boolean {
  return entry?.reason === "index" || entry?.reason === "single";
}

function galleryLabel(canvas: Canvas): string {
  if (canvas.galleryTemplatable) return "Listed as a template";
  if (canvas.galleryListed) return "Listed";
  if (!canvas.shared) return "Not listed. Share first";
  if (canvas.currentVersionId === null) return "Not listed. Publish first";
  if (canvas.hasPassword) return "Not listed. Remove password first";
  return "Not listed";
}

function accessLabel(canvas: Canvas): string {
  const parts = [
    canvas.shared
      ? `Shared${canvas.sharedExpiresAt ? ` (${expiryLabel(canvas.sharedExpiresAt)})` : ""}`
      : "Private",
  ];
  if (canvas.hasPassword) parts.push("password");
  return parts.join(", ");
}

function currentDeployLabel(current?: VersionInfo): string {
  if (!current) return "Never deployed";
  return `v${current.number} via ${sourceLabel(current.source)}, ${relativeTime(current.createdAt)}`;
}

function HealthCard({ canvas, current }: { canvas: Canvas; current?: VersionInfo }) {
  const entry = current?.entry;
  const sharedSuffix = canvas.shared ? " The shared link is affected too." : "";

  if (canvas.status === "disabled") {
    return (
      <StateCard tone="danger" title="Canvas disabled" icon="warning">
        <p>
          An administrator disabled this canvas, so its public URL is offline.
          {canvas.disabledReason ? (
            <>
              {" "}
              Reason: <span className="font-medium text-fg">{canvas.disabledReason}</span>.
            </>
          ) : null}
        </p>
      </StateCard>
    );
  }

  if (canvas.status === "archived") {
    return (
      <StateCard tone="warning" title="Canvas archived" icon="info">
        <p>
          This canvas is offline and hidden from your active list. Unarchive it to bring the same
          URL back.
          {sharedSuffix}
        </p>
      </StateCard>
    );
  }

  if (!current) {
    return (
      <StateCard
        tone="warning"
        title="No live deploy yet"
        icon="warning"
        actions={<RepairActions id={canvas.id} deployLabel="Deploy files" />}
      >
        <p>Publish a draft or deploy files before sharing this canvas. The URL has no live page.</p>
      </StateCard>
    );
  }

  if (entry?.reason === "none" || entry?.reason === "ambiguous") {
    return (
      <StateCard
        tone="warning"
        title="Root page missing"
        icon="warning"
        actions={<RepairActions id={canvas.id} deployLabel="Deploy files" />}
      >
        {entry.reason === "ambiguous" ? (
          <p>
            This deploy has multiple HTML pages but no <code>index.html</code>, so the canvas root
            does not know which page to serve. Rename the home page to <code>index.html</code> and
            publish again.
          </p>
        ) : (
          <p>
            This deploy has no HTML page, so the canvas root will not load. Add an{" "}
            <code>index.html</code> and publish again.
          </p>
        )}
      </StateCard>
    );
  }

  if (entry?.reason === "single") {
    return (
      <StateCard
        tone="neutral"
        title="Live, with an inferred home page"
        icon="info"
        actions={<DraftLink id={canvas.id} label="Open draft" />}
      >
        <p>
          The URL works because <code>{entry.path}</code> is the only HTML page. Rename it to{" "}
          <code>index.html</code> when you want the entry point to be explicit.
          {canvas.spaFallback ? " SPA fallback is on for deep links." : ""}
        </p>
      </StateCard>
    );
  }

  return (
    <StateCard tone="success" title="Canvas is live" icon="check">
      <p>
        The root page loads from the current deploy. Review the public URL before sharing widely.
      </p>
    </StateCard>
  );
}

function StateCard({
  tone,
  title,
  icon,
  actions,
  children,
}: {
  tone: "success" | "warning" | "danger" | "neutral";
  title: string;
  icon: "check" | "warning" | "info";
  actions?: ReactNode;
  children: ReactNode;
}) {
  const Icon = icon === "check" ? CheckCircle : icon === "warning" ? WarningCircle : Info;
  const toneClass = {
    success: "border-success/25 bg-success-subtle/35 text-success",
    warning: "border-warning/30 bg-warning-subtle/45 text-warning",
    danger: "border-danger/30 bg-danger-subtle/40 text-danger",
    neutral: "border-border bg-surface-raised text-muted",
  }[tone];

  return (
    <section className={cn("rounded-xl border p-4 shadow-[var(--shadow-panel)]", toneClass)}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="mt-0.5 inline-grid size-8 shrink-0 place-items-center rounded-md border border-current/20 bg-surface/50">
            <Icon size={18} weight="bold" aria-hidden />
          </span>
          <div className="min-w-0 space-y-1">
            <h2 className="text-base font-semibold tracking-tight text-fg">{title}</h2>
            <div className="max-w-3xl text-sm leading-relaxed text-muted">{children}</div>
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </section>
  );
}

function DraftLink({ id, label }: { id: string; label: string }) {
  return (
    <Link
      to="/canvases/$id/editor"
      params={{ id }}
      className="inline-flex h-8 items-center justify-center whitespace-nowrap rounded-md border border-border-strong bg-surface-raised px-3 text-[0.8125rem] font-medium text-fg shadow-[var(--shadow-xs)] transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:bg-surface-hover"
    >
      {label}
    </Link>
  );
}

function RepairActions({ id, deployLabel }: { id: string; deployLabel: string }) {
  return (
    <>
      <DraftLink id={id} label="Open draft" />
      <DeployButton canvasId={id} label={deployLabel} />
    </>
  );
}

function Fact({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 px-4 py-3", className)}>
      <dt className="text-[0.6875rem] font-medium text-subtle">{label}</dt>
      <dd className="mt-1 min-w-0 text-sm text-fg tabular-nums">{children}</dd>
    </div>
  );
}

/** Status tab: live health, the public URL, and the current deploy at a glance. Shows
 * the one-time "Your canvas is live" annotation right after a first deploy. */
export default function Overview() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { live } = useSearch({ strict: false }) as { live?: boolean };
  const { data: canvas, isLoading } = useCanvas(id);
  const { data: versions } = useVersions(id);
  const current = versions?.find((v) => v.current);
  // Total disk footprint = every kept (ready) version's bytes, not just the live one.
  const totalBytes = versions?.reduce((sum, v) => sum + v.totalBytes, 0) ?? 0;
  const deployCount = versions?.length ?? 0;
  const hasHomePageFact = current?.entry.path !== null && current?.entry.path !== undefined;

  if (isLoading || !canvas) {
    return (
      <TabContentFrame>
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </TabContentFrame>
    );
  }

  return (
    <TabContentFrame>
      {live && (
        <InlineNotice tone={rootWorks(current?.entry) ? "success" : "warning"}>
          Deploy finished.{" "}
          {rootWorks(current?.entry)
            ? "Review the live link before sharing."
            : "Fix the root page before sharing."}
        </InlineNotice>
      )}

      <HealthCard canvas={canvas} current={current} />

      <Panel className="p-0 sm:p-0">
        <dl className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
          <Fact label="Lifecycle">
            <StatusBadge status={canvas.status} />
          </Fact>
          <Fact label="Access">
            <span className={canvas.shared ? "text-fg" : "text-muted"}>{accessLabel(canvas)}</span>
          </Fact>
          <Fact label="Current deploy">
            <span title={current ? fullTime(current.createdAt) : undefined}>
              {currentDeployLabel(current)}
            </span>
          </Fact>
          <Fact label="Gallery">
            <span className={canvas.galleryListed ? "text-fg" : "text-muted"}>
              {galleryLabel(canvas)}
            </span>
          </Fact>
        </dl>
      </Panel>

      <Panel className="p-0 sm:p-0">
        <dl className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-6">
          <Fact label="Live URL" className={hasHomePageFact ? "lg:col-span-2" : "lg:col-span-3"}>
            <div className="flex min-w-0 items-center gap-2">
              <a
                href={canvas.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate font-mono text-xs text-accent hover:underline"
              >
                {canvas.url}
              </a>
              <CopyButton value={canvas.url} label="Copy" toastMessage="Link copied" />
              <IconLink href={canvas.url} target="_blank" rel="noreferrer" label="Open live canvas">
                <ArrowSquareOut size={15} weight="bold" aria-hidden />
              </IconLink>
            </div>
          </Fact>
          <Fact label="Files">
            {current ? (
              <span className="flex flex-wrap gap-x-2 gap-y-1">
                <span>{formatBytes(current.totalBytes)}</span>
                <span className="text-muted">
                  {current.fileCount} {current.fileCount === 1 ? "file" : "files"}
                </span>
              </span>
            ) : (
              <span className="text-muted">None</span>
            )}
          </Fact>
          <Fact label="Deploys">
            {deployCount > 0 ? (
              <Link
                to="/canvases/$id/versions"
                params={{ id }}
                className="text-accent hover:underline"
              >
                {deployCount} {deployCount === 1 ? "deploy" : "deploys"}
              </Link>
            ) : (
              <span className="text-muted">None yet</span>
            )}
          </Fact>
          <Fact label="Storage">
            <span title="Across all kept versions (newest 10)">
              {totalBytes > 0 ? formatBytes(totalBytes) : "None"}
            </span>
          </Fact>
          {current?.entry.path && (
            <Fact label="Home page">
              <code>{current.entry.path}</code>
              {current.entry.reason === "single" && <span className="text-muted"> inferred</span>}
            </Fact>
          )}
          {canvas.clonedFromCanvasId && (
            <Fact label="Origin">
              <span className="text-muted">Duplicated from another canvas</span>
            </Fact>
          )}
        </dl>
      </Panel>
    </TabContentFrame>
  );
}
