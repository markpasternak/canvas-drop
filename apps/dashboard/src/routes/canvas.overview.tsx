import { Info, WarningCircle } from "@phosphor-icons/react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "../components/Button.js";
import { CanvasCover, previewCoverUrl } from "../components/CanvasCover.js";
import { TabContentFrame } from "../components/CanvasDetail.js";
import { DeployButton } from "../components/DeployButton.js";
import { Dialog } from "../components/Dialog.js";
import { Field, TextareaField } from "../components/Field.js";
import { ReadError } from "../components/ReadError.js";
import { flatBandClass } from "../components/SettingsSection.js";
import { Skeleton } from "../components/Skeleton.js";
import { InlineNotice } from "../components/Surface.js";
import { TagsEditor } from "../components/TagsEditor.js";
import { ApiError, type Canvas, type RootEntry, type VersionInfo } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { formatBytes, fullTime, relativeTime, sourceLabel } from "../lib/format.js";
import { useUpdateSettings } from "../lib/mutations.js";
import { useCanvas, useDraft, useVersions } from "../lib/queries.js";
import { useUnsavedChanges } from "../lib/use-unsaved-changes.js";

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
  const { data: canvas, isLoading } = useCanvas(id);
  const versionQuery = useVersions(id);
  const { data: versions, isSuccess: versionsReady } = versionQuery;
  const update = useUpdateSettings(id);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const current = versions?.find((v) => v.current);
  // Total disk footprint = every kept (ready) version's bytes, not just the live one.
  const totalBytes = versions?.reduce((sum, v) => sum + v.totalBytes, 0) ?? 0;
  const deployCount = versions?.length ?? 0;
  const [baseline, setBaseline] = useState<{
    title: string;
    description: string;
    tags: string[];
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty =
    baseline !== null &&
    (title !== baseline.title ||
      description !== baseline.description ||
      JSON.stringify(tags) !== JSON.stringify(baseline.tags));
  const blocker = useUnsavedChanges({ dirty: dirty || update.isPending });

  // Seed editable identity fields on canvas identity only so optimistic writes
  // elsewhere don't clobber an in-progress title/description edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed on identity change only
  useEffect(() => {
    if (!canvas) return;
    setBaseline({
      title: canvas.title,
      description: canvas.description ?? "",
      tags: canvas.tags ?? [],
    });
    setSaveError(null);
    setSaved(false);
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

  const revert = () => {
    if (!baseline) return;
    setTitle(baseline.title);
    setDescription(baseline.description);
    setTags(baseline.tags);
    setSaveError(null);
    setSaved(false);
  };
  const save = async () => {
    if (!baseline || update.isPending) return false;
    const patch = {
      ...(title !== baseline.title ? { title } : {}),
      ...(description !== baseline.description ? { description: description || null } : {}),
      ...(JSON.stringify(tags) !== JSON.stringify(baseline.tags) ? { tags } : {}),
    };
    setSaveError(null);
    try {
      const result = await update.mutateAsync(patch);
      const next = {
        title: result.title,
        description: result.description ?? "",
        tags: result.tags ?? [],
      };
      setBaseline(next);
      setTitle(next.title);
      setDescription(next.description);
      setTags(next.tags);
      setSaved(true);
      return true;
    } catch (err) {
      setSaveError(
        err instanceof ApiError
          ? err.hint
          : "Couldn't save these details. Your changes are still here.",
      );
      return false;
    }
  };

  return (
    <TabContentFrame>
      {live && versionsReady && (
        <InlineNotice tone={rootWorks(current?.entry) ? "success" : "warning"}>
          Published.{" "}
          {rootWorks(current?.entry)
            ? "Review the link before sharing."
            : "Fix the root page before sharing."}
        </InlineNotice>
      )}

      <HealthCard canvas={canvas} current={current} versionsReady={versionsReady} />
      {versionQuery.isError && (
        <ReadError
          title="Couldn’t load version details"
          onRetry={() => void versionQuery.refetch()}
          retrying={versionQuery.isFetching}
        />
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
            <h2 className="font-display text-h2 leading-tight tracking-tight">
              {current
                ? `Published version ${current.number}`
                : canvas.currentVersionId
                  ? "Published version"
                  : versionsReady
                    ? "Ready when you are"
                    : "Canvas overview"}
            </h2>
            {canvas.description && (
              <p className="line-clamp-3 text-sm leading-relaxed text-muted">
                {canvas.description}
              </p>
            )}
          </div>
          {current && (
            <p className="text-sm text-muted" title={fullTime(current.createdAt)}>
              Published {relativeTime(current.createdAt)} via {sourceLabel(current.source)}.
            </p>
          )}
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

      <section className={flatBandClass}>
        <dl className="-mx-4 grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-3">
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
        <dl className="-mx-4 grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
          <Fact label="Files">
            {!versionsReady ? (
              <span className="text-muted">
                {versionQuery.isError ? "Unavailable" : "Loading…"}
              </span>
            ) : current ? (
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
            {!versionsReady ? (
              <span className="text-muted">
                {versionQuery.isError ? "Unavailable" : "Loading…"}
              </span>
            ) : deployCount > 0 ? (
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
            <span title="Across all kept versions">
              {!versionsReady
                ? versionQuery.isError
                  ? "Unavailable"
                  : "Loading…"
                : totalBytes > 0
                  ? formatBytes(totalBytes)
                  : "None"}
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
          Title, description, and tags help people identify this canvas. Save them together when
          ready.
        </p>
        <fieldset
          disabled={canvas.status === "disabled" || update.isPending}
          className="mt-5 max-w-3xl space-y-4"
        >
          <Field
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
          <TextareaField
            label="Description"
            value={description}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
          />
          <TagsEditor
            value={tags}
            onChange={setTags}
            hint="Enter or comma to add"
            description="Tags help you filter your canvases here, and appear publicly in the gallery once this canvas is listed."
          />
        </fieldset>
        {saveError && (
          <InlineNotice tone="danger" role="alert">
            {saveError} Your attempted details are retained. Retry or revert below.
          </InlineNotice>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            disabled={!dirty || canvas.status === "disabled"}
            loading={update.isPending}
            onClick={() => void save()}
          >
            {saveError ? "Retry save" : "Save details"}
          </Button>
          {dirty && (
            <Button variant="ghost" size="sm" disabled={update.isPending} onClick={revert}>
              Revert changes
            </Button>
          )}
          <p role="status" className="text-sm text-muted">
            {update.isPending
              ? "Saving details…"
              : dirty
                ? "Unsaved changes"
                : saved
                  ? "Details saved"
                  : ""}
          </p>
        </div>
      </details>
      <Dialog
        open={blocker.status === "blocked"}
        onClose={() => blocker.reset?.()}
        title="Save your canvas details?"
        description="Your title, description or tags have unsaved changes."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            loading={update.isPending}
            onClick={async () => {
              if (await save()) blocker.proceed?.();
            }}
          >
            Save and leave
          </Button>
          <Button variant="secondary" disabled={update.isPending} onClick={() => blocker.reset?.()}>
            Keep editing
          </Button>
          <Button
            variant="ghost"
            disabled={update.isPending}
            onClick={() => {
              revert();
              blocker.proceed?.();
            }}
          >
            Discard and leave
          </Button>
        </div>
        {saveError && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {saveError}
          </p>
        )}
      </Dialog>
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
