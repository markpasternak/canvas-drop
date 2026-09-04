import { ArrowSquareOut, Info, WarningCircle } from "@phosphor-icons/react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { accessRungLabel, PublicationBadge } from "../components/Badge.js";
import { CanvasCover, previewCoverUrl } from "../components/CanvasCover.js";
import { TabContentFrame } from "../components/CanvasDetail.js";
import { CopyButton } from "../components/CopyButton.js";
import { DeployButton } from "../components/DeployButton.js";
import { Field, TextareaField } from "../components/Field.js";
import { IconLink } from "../components/IconButton.js";
import { flatBandClass } from "../components/SettingsSection.js";
import { Skeleton } from "../components/Skeleton.js";
import { InlineNotice } from "../components/Surface.js";
import { TagsEditor } from "../components/TagsEditor.js";
import { useToast } from "../components/Toast.js";
import { ApiError, type Canvas, type RootEntry, type VersionInfo } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { expiryLabel, formatBytes, fullTime, relativeTime, sourceLabel } from "../lib/format.js";
import { useUpdateSettings } from "../lib/mutations.js";
import { useCanvas, useDraft, useVersions } from "../lib/queries.js";

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
  const base = accessRungLabel(canvas.access);
  const head = canvas.sharedExpiresAt ? `${base} (${expiryLabel(canvas.sharedExpiresAt)})` : base;
  const parts = [head];
  if (canvas.hasPassword) parts.push("password");
  return parts.join(", ");
}

function currentVersionLabel(current?: VersionInfo): string {
  if (!current) return "Not published";
  return `v${current.number} via ${sourceLabel(current.source)}, ${relativeTime(current.createdAt)}`;
}

function HealthCard({
  canvas,
  current,
  versionsReady,
}: {
  canvas: Canvas;
  current?: VersionInfo;
  versionsReady: boolean;
}) {
  const entry = current?.entry;
  const sharedSuffix = canvas.shared ? " The shared link is affected too." : "";

  if (canvas.status === "disabled") {
    return (
      <StateCard tone="danger" title="Canvas disabled" icon="warning">
        <p>
          An administrator disabled this canvas, so its canvas URL is offline.
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
    // Only claim "not published" when the versions list actually loaded — while
    // it's still loading (or failed), `current` is merely unknown, and a false
    // warning on a published canvas is alarming.
    if (!versionsReady) return null;
    return (
      <StateCard
        tone="warning"
        title="Not published yet"
        icon="warning"
        actions={<RepairActions id={canvas.id} deployLabel="Upload new version" />}
      >
        <p>Publish this canvas before sharing it. The URL has no live page.</p>
      </StateCard>
    );
  }

  if (entry?.reason === "none" || entry?.reason === "ambiguous") {
    return (
      <StateCard
        tone="warning"
        title="Root page missing"
        icon="warning"
        actions={<RepairActions id={canvas.id} deployLabel="Upload new version" />}
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
        title="Published, with an inferred home page"
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

  return null;
}

function StateCard({
  tone,
  title,
  icon,
  actions,
  children,
}: {
  tone: "warning" | "danger" | "neutral";
  title: string;
  icon: "warning" | "info";
  actions?: ReactNode;
  children: ReactNode;
}) {
  const Icon = icon === "warning" ? WarningCircle : Info;
  const toneClass = {
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

/** Overview tab: identity, live health, the public URL, and the current deploy at
 * a glance. Shows the one-time "Your canvas is live" annotation after publish. */
export default function Overview() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { live } = useSearch({ strict: false }) as { live?: boolean };
  const toast = useToast();
  const { data: canvas, isLoading } = useCanvas(id);
  const { data: versions, isSuccess: versionsReady } = useVersions(id);
  const update = useUpdateSettings(id);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const current = versions?.find((v) => v.current);
  // Total disk footprint = every kept (ready) version's bytes, not just the live one.
  const totalBytes = versions?.reduce((sum, v) => sum + v.totalBytes, 0) ?? 0;
  const deployCount = versions?.length ?? 0;
  const hasHomePageFact = current?.entry.path !== null && current?.entry.path !== undefined;

  // Seed editable identity fields on canvas identity only so optimistic writes
  // elsewhere don't clobber an in-progress title/description edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed on identity change only
  useEffect(() => {
    if (!canvas) return;
    setTitle(canvas.title);
    setDescription(canvas.description ?? "");
    setTags(canvas.tags ?? []);
  }, [canvas?.id]);

  if (isLoading || !canvas) {
    return (
      <TabContentFrame>
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </TabContentFrame>
    );
  }

  // Basics save (title/description/tags). The cache rolls back on a server reject
  // (useUpdateSettings onError), but the local mirrors here would NOT — leaving the
  // input showing a value the server rejected with no feedback. So await the write,
  // surface an error toast, and on failure snap the local mirrors back to the
  // server-truth canvas values (the optimistic UX still holds on success).
  const save = async (patch: Parameters<typeof update.mutate>[0]) => {
    try {
      await update.mutateAsync(patch);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't save that change", "error");
      setTitle(canvas.title);
      setDescription(canvas.description ?? "");
      setTags(canvas.tags ?? []);
    }
  };

  return (
    <TabContentFrame>
      {live && (
        <InlineNotice tone={rootWorks(current?.entry) ? "success" : "warning"}>
          Published.{" "}
          {rootWorks(current?.entry)
            ? "Review the link before sharing."
            : "Fix the root page before sharing."}
        </InlineNotice>
      )}

      <section
        aria-label="Canvas preview and actions"
        className="grid gap-6 lg:grid-cols-[1.35fr_1fr] lg:items-center"
      >
        {canvas.status === "active" && canvas.currentVersionId && rootWorks(current?.entry) ? (
          <a
            href={canvas.url}
            target="_blank"
            rel="noreferrer"
            aria-label="View published canvas"
            className="block aspect-[16/9] overflow-hidden rounded-xl border border-border bg-surface-sunken transition-opacity hover:opacity-90"
          >
            <CanvasCover
              key={canvas.currentVersionId}
              seed={id}
              title={canvas.title}
              previewUrl={
                canvas.previewMode === "off"
                  ? undefined
                  : `${previewCoverUrl(canvas.url)}&v=${canvas.updatedAt}`
              }
            />
          </a>
        ) : (
          <div className="aspect-[16/9] overflow-hidden rounded-xl border border-border bg-surface-sunken">
            <CanvasCover seed={id} title={canvas.title} />
          </div>
        )}
        <div className="min-w-0 space-y-5">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">
              {canvas.currentVersionId ? "Published version" : "Your canvas"}
            </p>
            <h2 className="font-display text-h2 leading-tight tracking-tight">
              {current
                ? `Version ${current.number}`
                : canvas.currentVersionId
                  ? "Published version"
                  : "Ready when you are"}
            </h2>
            {canvas.description && (
              <p className="line-clamp-3 text-sm leading-relaxed text-muted">
                {canvas.description}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <PublicationBadge state={canvas.publicationState} />
            <span className="text-muted">{accessLabel(canvas)}</span>
          </div>
          {canvas.status === "active" && <DraftSummary id={id} />}
          {canvas.status === "active" && (
            <div className="flex flex-wrap items-center gap-4">
              <DraftLink id={id} label="Edit draft" />
              <Link
                to="/canvases/$id/share"
                params={{ id }}
                className="text-sm font-medium text-accent hover:underline"
              >
                Manage access
              </Link>
            </div>
          )}
        </div>
      </section>

      <HealthCard canvas={canvas} current={current} versionsReady={versionsReady} />

      <section className={flatBandClass}>
        <dl className="-mx-4 grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
          <Fact label="Current version">
            <span title={current ? fullTime(current.createdAt) : undefined}>
              {versionsReady ? currentVersionLabel(current) : "Version details unavailable"}
            </span>
          </Fact>
          <Fact label="Gallery">
            <span className={canvas.galleryListed ? "text-fg" : "text-muted"}>
              {galleryLabel(canvas)}
            </span>
          </Fact>
          <Fact label="Created">
            <span title={fullTime(canvas.createdAt)}>{relativeTime(canvas.createdAt)}</span>
          </Fact>
          <Fact label="Updated">
            <span title={fullTime(canvas.updatedAt)}>{relativeTime(canvas.updatedAt)}</span>
          </Fact>
        </dl>
      </section>

      <section className={flatBandClass}>
        <dl className="-mx-4 grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-6">
          <Fact label="Canvas URL" className={hasHomePageFact ? "lg:col-span-2" : "lg:col-span-3"}>
            <div className="flex min-w-0 items-center gap-2">
              {canvas.status === "active" && canvas.currentVersionId ? (
                <a
                  href={canvas.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate font-mono text-xs text-accent hover:underline"
                >
                  {canvas.url}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
                  {canvas.url}
                </span>
              )}
              <CopyButton value={canvas.url} label="Copy" toastMessage="Link copied" />
              {canvas.status === "active" && canvas.currentVersionId && (
                <IconLink
                  href={canvas.url}
                  target="_blank"
                  rel="noreferrer"
                  label="Open live canvas"
                >
                  <ArrowSquareOut size={15} weight="bold" aria-hidden />
                </IconLink>
              )}
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
          <Fact label="Versions">
            {deployCount > 0 ? (
              <Link
                to="/canvases/$id/versions"
                params={{ id }}
                className="text-accent hover:underline"
              >
                {deployCount} {deployCount === 1 ? "version" : "versions"}
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
      </section>
      <details id="basics" className={flatBandClass}>
        <summary className="cursor-pointer font-display text-h2 tracking-tight">
          Edit details
        </summary>
        <p className="mt-2 text-sm text-muted">
          Title, description, and tags. Changes save when you leave a field.
        </p>
        <fieldset disabled={canvas.status === "disabled"} className="mt-5 max-w-3xl space-y-4">
          <Field
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              if (title !== canvas.title) void save({ title });
            }}
            maxLength={200}
          />
          <TextareaField
            label="Description"
            value={description}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => {
              if ((description || null) !== canvas.description) {
                void save({ description: description || null });
              }
            }}
            maxLength={2000}
          />
          <TagsEditor
            value={tags}
            onChange={(next) => {
              setTags(next);
              void save({ tags: next });
            }}
            hint="Enter or comma to add"
            description="Tags help you filter your canvases here, and appear publicly in the gallery once this canvas is listed."
          />
        </fieldset>
      </details>
    </TabContentFrame>
  );
}

/** Uses the existing editor read, which initializes the draft from the current
 * version on first open. Never infer saved or published state when it fails. */
function DraftSummary({ id }: { id: string }) {
  const { data: draft, isError } = useDraft(id);
  return (
    <p className="text-sm leading-relaxed text-muted">
      {isError
        ? "Open the editor to review your draft."
        : !draft
          ? "Checking your draft…"
          : draft.stale
            ? "A newer version was published. Review your draft before publishing."
            : draft.dirty
              ? "Your draft has unpublished changes. Publish when it’s ready for the team."
              : draft.files.length === 0
                ? "Add content in the editor, then publish when you’re ready."
                : "Your draft matches the published version. Edits stay in draft until you publish."}
    </p>
  );
}
