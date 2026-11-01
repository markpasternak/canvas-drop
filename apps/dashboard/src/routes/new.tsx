import { ArrowRight, Code, FileHtml, FolderOpen, type Icon, Key } from "@phosphor-icons/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import { CodeBox } from "../components/CodeBox.js";
import { CopyButton } from "../components/CopyButton.js";
import { CreatePreview, createDocumentPreview } from "../components/CreatePreview.js";
import { CreateSuccess, type PublishedCanvasResult } from "../components/CreateSuccess.js";
import {
  canvasRelativePaths,
  FileDropOrProgress,
  rawUploadPath,
} from "../components/DeployFiles.js";
import { Dialog } from "../components/Dialog.js";
import { DraftPreview } from "../components/DraftPreview.js";
import { Field, TextareaField } from "../components/Field.js";
import { PublishReviewDialog } from "../components/PublishReviewDialog.js";
import { ReadError } from "../components/ReadError.js";
import { SlugField } from "../components/SlugField.js";
import { InlineNotice, PageHeader } from "../components/Surface.js";
import { Toggle } from "../components/Toggle.js";
import { ApiError, api, type DraftView } from "../lib/api.js";
import { archivePath, readUploadArchive, UPLOAD_ARCHIVE_MAX_BYTES } from "../lib/canvas-archive.js";
import { cn } from "../lib/cn.js";
import {
  applyCreateAudience,
  type CreateAudienceChoice,
  type CreateAudienceState,
  defaultCreateAudience,
  resetAudienceForDestination,
} from "../lib/create-audience.js";
import {
  type CreateMethod,
  clearCreateRecovery,
  type PendingCreateDraft,
  readCreateRecovery,
  type SelectedUpload,
  writeCreateRecovery,
} from "../lib/create-recovery.js";
import { deployCurl } from "../lib/deploy-curl.js";
import { draftUsesScripts } from "../lib/file-kind.js";
import { useMe } from "../lib/queries.js";
import type { SlugStatus } from "../lib/use-slug-availability.js";
import { useUnsavedChanges } from "../lib/use-unsaved-changes.js";

type Method = CreateMethod;
type MethodConfig = {
  id: Method;
  label: string;
  icon: Icon;
};

const METHODS = [
  {
    id: "paste",
    label: "Paste HTML",
    icon: FileHtml,
  },
  {
    id: "upload",
    label: "Upload files",
    icon: FolderOpen,
  },
  {
    id: "api",
    label: "Use the API",
    icon: Code,
  },
] satisfies [MethodConfig, ...MethodConfig[]];

export default function CreateCanvas() {
  const me = useMe();
  if (me.isPending)
    return (
      <p role="status" className="text-sm text-muted">
        Loading your workspace…
      </p>
    );
  if (me.isError && !me.data)
    return (
      <ReadError title="Couldn't load workspace information" onRetry={() => void me.refetch()} />
    );
  const account = me.data?.id;
  return <CreateCanvasForm key={account ?? "loading"} accountId={account} />;
}

function CreateCanvasForm({ accountId }: { accountId: string | undefined }) {
  const [recovered] = useState(() => readCreateRecovery(accountId));
  const search = useSearch({ strict: false }) as { method?: string };
  const navigate = useNavigate();

  const initial =
    search.method === "folder" || search.method === "zip"
      ? "upload"
      : (METHODS.find((m) => m.id === search.method)?.id ?? "paste");
  const [method, setMethod] = useState<Method>(recovered?.method ?? initial);
  const [title, setTitle] = useState(recovered?.title ?? "");
  const [titleEdited, setTitleEdited] = useState(recovered?.titleEdited ?? false);
  // Optional custom slug (plan 004). `slug` is the cosmetic-normalized value; `status`
  // gates submit — blocked when a slug is entered but not confirmed available.
  const meQuery = useMe();
  const me = meQuery.data;
  const busyRef = useRef(false);
  const [slug, setSlug] = useState<{ slug: string; status: SlugStatus }>({
    slug: recovered?.slug ?? "",
    status: "idle",
  });
  const slugBlocked = slug.slug !== "" && slug.status !== "available";
  // Home tenant for the new canvas (plan 002 U6). Personal (null) or one of the caller's
  // orgs. `undefined` = not explicitly chosen → fall back to the members-default-Org rule.
  // The server re-validates against the caller's membership regardless (never trusts this).
  const orgs = me?.orgs ?? [];
  const [workspace, setWorkspace] = useState<string | null | undefined>(recovered?.workspace);
  // Default selection: a member of exactly one org lands in it; everyone else is Personal.
  const homeOrgId = workspace === undefined ? (orgs.length === 1 ? orgs[0]?.id : null) : workspace;
  // Backend-group master switch chosen at create time (plan 006). Off by default;
  // changeable later in the canvas Backend tab.
  const [backendEnabled, setBackendEnabled] = useState(recovered?.backendEnabled ?? false);
  const [audience, setAudience] = useState(() =>
    recovered ? { ...recovered.audience, password: "" } : defaultCreateAudience(),
  );
  const [html, setHtml] = useState(recovered?.html ?? "");
  const [upload, setUpload] = useState<SelectedUpload | null>(recovered?.upload ?? null);
  const preview = useMemo(
    () => (method === "paste" ? createDocumentPreview(html) : null),
    [html, method],
  );
  const canvasTitle = titleEdited ? title : (preview?.title ?? "");
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(
    recovered?.pending ? "Your upload is unfinished. Retry to continue the saved draft." : null,
  );
  // Upload progress: null = not uploading; 0-100 = % of bytes sent (100 = sent,
  // server now extracting/publishing).
  const [progress, setProgress] = useState<number | null>(null);

  const [revealed, setRevealed] = useState<PublishedCanvasResult | null>(null);
  const [apiResult, setApiResult] = useState<{ id: string; apiKey: string; url: string } | null>(
    null,
  );

  function fail(err: unknown) {
    busyRef.current = false;
    setError(
      err instanceof ApiError
        ? err.hint
        : err instanceof Error
          ? err.message
          : "Something went wrong. Try again.",
    );
    setBusy(false);
    setProgress(null);
  }

  const audienceBlocked =
    audience.choice === "public" && audience.requirePassword && audience.password.trim() === "";

  function validateAudience(): boolean {
    if (!audienceBlocked) return true;
    setError("Enter a password, or turn off Require password.");
    return false;
  }

  const [prepared, setPrepared] = useState<{
    canvas: PendingCreateDraft["canvas"];
    draft: DraftView;
  } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const completedRef = useRef(false);
  const pendingRef = useRef<PendingCreateDraft | null>(recovered?.pending ?? null);
  const hasInput = !!(
    html ||
    title ||
    slug.slug ||
    upload ||
    backendEnabled ||
    workspace !== undefined ||
    audience.choice !== "private"
  );
  const blocker = useUnsavedChanges({
    dirty: busy || (hasInput && !prepared && !revealed && !apiResult && !leaving),
    saveBeforeLeave: async () => completedRef.current,
  });
  useEffect(() => {
    if (completedRef.current) return;
    writeCreateRecovery(accountId, {
      method,
      title,
      titleEdited,
      html,
      slug: slug.slug,
      workspace,
      backendEnabled,
      audience,
      upload,
      pending: pendingRef.current,
    });
  });

  function discardInput() {
    clearCreateRecovery();
    setTitle("");
    setTitleEdited(false);
    setHtml("");
    setUpload(null);
    setSlug({ slug: "", status: "idle" });
    setFormKey((key) => key + 1);
    setWorkspace(undefined);
    setBackendEnabled(false);
    setAudience(defaultCreateAudience());
    setError(null);
    pendingRef.current = null;
  }

  const audienceLabel =
    audience.choice === "private"
      ? "Restricted · Only you can open it"
      : audience.choice === "workspace"
        ? `Everyone in ${orgs.find((org) => org.id === homeOrgId)?.name ?? "your workspace"}`
        : `Public link · Anyone with the link${audience.requirePassword ? " and password" : ""}`;

  async function stageDraft(files: Array<{ path: string; body: Blob }>) {
    if (
      busyRef.current ||
      meQuery.isPending ||
      meQuery.isError ||
      (slugBlocked && !pendingRef.current)
    )
      return;
    if (!files.length) {
      setError("Choose at least one usable canvas file.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      if (!pendingRef.current) {
        const canvas = await api.createCanvas({
          title: canvasTitle || undefined,
          backendEnabled,
          slug: slug.slug || undefined,
          orgId: homeOrgId,
        });
        pendingRef.current = { canvas, files, next: 0, uncertain: false };
      }
      const pending = pendingRef.current;
      for (; pending.next < pending.files.length; pending.next++) {
        const file = pending.files[pending.next];
        if (!file) continue;
        if (pending.uncertain) {
          const current = await api.getDraft(pending.canvas.id);
          const existing = current.files.find((entry) => entry.path === file.path);
          if (existing) {
            const hash = Array.from(
              new Uint8Array(await crypto.subtle.digest("SHA-256", await file.body.arrayBuffer())),
              (byte) => byte.toString(16).padStart(2, "0"),
            ).join("");
            if (existing.hash !== hash)
              throw new Error(
                `${file.path} changed in the saved draft. Open it to compare before replacing anything.`,
              );
            pending.uncertain = false;
            setProgress(Math.round(((pending.next + 1) / pending.files.length) * 100));
            continue;
          }
        }
        pending.uncertain = true;
        await api.uploadDraftFile(pending.canvas.id, file.path, file.body, "none");
        pending.uncertain = false;
        setProgress(Math.round(((pending.next + 1) / pending.files.length) * 100));
      }
      const draft = await api.getDraft(pending.canvas.id);
      completedRef.current = true;
      clearCreateRecovery();
      setPrepared({ canvas: pending.canvas, draft });
      busyRef.current = false;
      setBusy(false);
      setProgress(null);
    } catch (err) {
      fail(err);
    }
  }

  async function createPaste() {
    if (!html.trim()) return;
    await stageDraft([{ path: "index.html", body: new Blob([html], { type: "text/html" }) }]);
  }

  async function createWithUpload(kind: "folder" | "zip", files: File[]) {
    if (busyRef.current) return;
    try {
      if (kind === "zip") {
        const file = files[0];
        if (!file) return;
        if (file.size > UPLOAD_ARCHIVE_MAX_BYTES)
          throw new Error(
            "ZIP uploads are limited to 110 MB, with 100 MB of expanded canvas files.",
          );
        const entries = readUploadArchive(new Uint8Array(await file.arrayBuffer()));
        await stageDraft(
          entries.map((entry) => ({ path: entry.path, body: new Blob([entry.bytes]) })),
        );
      } else {
        const paths = canvasRelativePaths(files);
        await stageDraft(
          files.flatMap((body, i) => {
            const path = archivePath(paths[i] ?? body.name);
            return path ? [{ path, body }] : [];
          }),
        );
      }
    } catch (err) {
      fail(err);
    }
  }

  async function reviewDraft() {
    if (!prepared || busyRef.current || !validateAudience()) return;
    setError(null);
    setReviewOpen(true);
  }

  async function createApiOnly() {
    if (busyRef.current || meQuery.isPending || meQuery.isError) return;
    if (slugBlocked) {
      setError("Pick an available slug, or clear it for a random one.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const canvas = await api.createCanvas({
        title: canvasTitle || undefined,
        backendEnabled,
        slug: slug.slug || undefined,
        orgId: homeOrgId,
      });
      completedRef.current = true;
      clearCreateRecovery();
      setApiResult({ id: canvas.id, apiKey: canvas.apiKey, url: canvas.url });
      setBusy(false);
    } catch (err) {
      fail(err);
    }
  }

  function finish(id: string, deployed: boolean, shareFailed = false) {
    setLeaving(true);
    setRevealed(null);
    setApiResult(null);
    if (shareFailed) {
      navigate({ to: "/canvases/$id/share", params: { id } });
      return;
    }
    navigate({ to: "/canvases/$id", params: { id }, search: deployed ? { live: true } : {} });
  }

  function selectFiles(files: File[]) {
    if (busyRef.current) return;
    setUpload(null);
    setError(null);
    if (!files.length) return;
    const first = files[0];
    // A ZIP inside a selected folder is a downloadable asset, not a deploy archive.
    const archive =
      files.length === 1 &&
      first &&
      /\.zip$/i.test(first.name) &&
      !rawUploadPath(first).includes("/");
    if (archive && first.size === 0) {
      setError("This ZIP is empty. Choose a ZIP containing your site.");
      return;
    }
    const paths = canvasRelativePaths(files);
    if (new Set(paths).size !== paths.length) {
      setError("Two files have the same path. Choose files with unique paths.");
      return;
    }
    setUpload({ kind: archive ? "zip" : "folder", files, paths });
  }

  if (leaving) return <PageHeader title="Opening your canvas…" />;
  const blocked = slugBlocked || meQuery.isPending || meQuery.isError;
  if (revealed)
    return (
      <CreateSuccess
        result={revealed}
        onDone={() => finish(revealed.id, true, revealed.shareFailed)}
      />
    );
  if (apiResult)
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader
          title="Your canvas is ready for the API"
          description="Save your key, then publish your first version."
        />
        <ApiSnippet result={apiResult} onDone={() => finish(apiResult.id, false)} />
      </div>
    );

  if (prepared)
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <PageHeader
          title="Your draft is ready"
          description="Saved to your canvases. Preview it, keep editing, or review before publishing."
        />
        {error && (
          <InlineNotice tone="danger" role="alert">
            {error}
          </InlineNotice>
        )}
        <div className="flex flex-wrap items-start justify-between gap-5 border-y border-border py-5">
          <dl className="grid min-w-0 gap-x-8 gap-y-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted">Destination</dt>
              <dd className="text-sm font-medium">
                {orgs.find((org) => org.id === homeOrgId)?.name ?? "Personal"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Content</dt>
              <dd className="text-sm">
                {prepared.draft.files.length} files ·{" "}
                <code>{prepared.draft.entry?.path ?? "No entry page"}</code>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Audience when published</dt>
              <dd className="text-sm">{audienceLabel}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                navigate({ to: "/canvases/$id/editor", params: { id: prepared.canvas.id } })
              }
            >
              Continue editing
            </Button>
            <Button loading={busy} onClick={() => void reviewDraft()}>
              Review and publish
            </Button>
          </div>
        </div>
        {audience.choice === "public" && audience.requirePassword && (
          <Field
            label="Password for publication"
            type="password"
            value={audience.password}
            onChange={(event) =>
              setAudience((current) => ({ ...current, password: event.target.value }))
            }
            autoComplete="new-password"
          />
        )}
        <div className="h-[min(60dvh,36rem)] min-h-72">
          <DraftPreview
            canvasId={prepared.canvas.id}
            refreshKey={previewKey}
            onRefresh={() => setPreviewKey((key) => key + 1)}
            fullscreen={previewFullscreen}
            onToggleFullscreen={() => setPreviewFullscreen((open) => !open)}
            usesScripts={draftUsesScripts(prepared.draft.files)}
          />
        </div>
        <p className="text-sm text-muted">
          Your draft stays unpublished until you confirm Publish. Signed-in backend features can
          only run after publication.
        </p>
        {reviewOpen && (
          <PublishReviewDialog
            canvasId={prepared.canvas.id}
            plannedAudience={audienceLabel}
            onClose={() => setReviewOpen(false)}
            onPublished={async () => {
              const outcome = await applyCreateAudience(
                prepared.canvas.id,
                audience,
                api.updateSettings,
              );
              setRevealed({
                id: prepared.canvas.id,
                url: prepared.canvas.url,
                apiKey: prepared.canvas.apiKey ?? "",
                audience: outcome.kind === "failed" ? "Sharing needs verification" : audienceLabel,
                shareFailed: outcome.kind === "failed",
              });
            }}
          />
        )}
      </div>
    );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Create a canvas"
        description="Start with something you’ve made. Give it a home and a link."
      />
      {error && (
        <InlineNotice tone="danger" role="alert">
          {error}
          {pendingRef.current && (
            <p className="mt-2">
              The canvas exists as an unpublished draft. Retry the upload here, or{" "}
              <a className="underline" href={`/canvases/${pendingRef.current.canvas.id}/editor`}>
                open the saved draft
              </a>{" "}
              to recover it.
            </p>
          )}
        </InlineNotice>
      )}
      {meQuery.isError && (
        <InlineNotice tone="danger" role="alert">
          Workspace information couldn’t load.{" "}
          <button type="button" className="underline" onClick={() => meQuery.refetch()}>
            Try again
          </button>
        </InlineNotice>
      )}
      {pendingRef.current && !busy && (
        <Button onClick={() => pendingRef.current && void stageDraft(pendingRef.current.files)}>
          Retry draft upload
        </Button>
      )}
      <fieldset
        disabled={busy || !!pendingRef.current}
        className="min-w-0 space-y-7 border-0 p-0"
        aria-busy={busy}
      >
        <section aria-label="Creation method" className="space-y-5">
          <div className="flex flex-wrap gap-1 border-b border-border pb-2">
            {METHODS.map((m) => {
              const MethodIcon = m.icon;
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={method === m.id}
                  onClick={() => {
                    setMethod(m.id);
                    if (m.id === "api") setAudience(defaultCreateAudience());
                    setError(null);
                  }}
                  className={cn(
                    "inline-flex min-h-11 items-center gap-2 rounded-md px-4 py-2 text-sm",
                    method === m.id
                      ? "bg-accent-subtle text-accent font-medium"
                      : "text-muted hover:bg-surface-sunken hover:text-fg",
                  )}
                >
                  <MethodIcon size={18} aria-hidden />
                  {m.label}
                </button>
              );
            })}
          </div>
          {method === "paste" && (
            <div className="grid gap-5 lg:grid-cols-2">
              <TextareaField
                label="HTML"
                mono
                rows={12}
                className="h-72 resize-y"
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                placeholder={
                  "<!doctype html>\n<title>My first canvas</title>\n<h1>Hello, team.</h1>"
                }
              />
              <CreatePreview html={html} preview={preview} />
            </div>
          )}
          {method === "upload" && (
            <div className="space-y-4">
              <p className="text-sm text-muted">
                Review your files, then publish when you’re ready. Relative paths are preserved.
              </p>
              <FileDropOrProgress
                busy={busy}
                pct={progress}
                label="Drop files, a folder, or one ZIP here"
                variant="folder"
                onFiles={selectFiles}
              />
              {upload && (
                <section
                  aria-label="Selected files"
                  className="space-y-3 border-t border-border pt-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">
                      {upload.kind === "zip"
                        ? "ZIP archive ready"
                        : `${upload.files.length} files ready`}{" "}
                      <span className="font-normal text-muted">
                        ·{" "}
                        {Math.max(
                          1,
                          Math.ceil(upload.files.reduce((sum, file) => sum + file.size, 0) / 1024),
                        )}{" "}
                        KB
                      </span>
                    </p>
                    <Button size="sm" variant="ghost" onClick={() => setUpload(null)}>
                      Clear selection
                    </Button>
                  </div>
                  <ul className="max-h-40 overflow-auto text-xs font-mono text-muted">
                    {upload.paths.map((path) => (
                      <li key={path} className="break-all py-1">
                        {path}
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-muted">
                    {upload.kind === "zip"
                      ? "The archive will be checked and unpacked into an unpublished draft."
                      : "Files are staged here. Nothing has been uploaded yet."}{" "}
                    Preview the draft before publishing. Files stay in this tab only until uploaded.
                  </p>
                </section>
              )}
            </div>
          )}
          {method === "api" && (
            <ApiPathIntro
              me={me ? { urlMode: me.urlMode, baseUrl: me.baseUrl } : undefined}
              slug={slug.slug}
            />
          )}
        </section>
        <div className="grid gap-7 border-t border-border pt-6 lg:grid-cols-2">
          <div className="space-y-5">
            <Field
              label="Title"
              hint="optional"
              value={canvasTitle}
              onChange={(e) => {
                setTitleEdited(true);
                setTitle(e.target.value);
              }}
              placeholder="My prototype"
              maxLength={200}
            />
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-fg">Workspace</span>
              <select
                value={homeOrgId ?? ""}
                onChange={(e) => {
                  setWorkspace(e.target.value === "" ? null : e.target.value);
                  setAudience(resetAudienceForDestination);
                }}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
              >
                <option value="">Personal</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <span className="block text-xs text-muted">
                Where this canvas lives. You can change sharing later; the workspace is fixed after
                creation.
              </span>
            </label>
          </div>
          {method !== "api" && (
            <CreateAudience
              workspaceName={orgs.find((org) => org.id === homeOrgId)?.name}
              canPublishPublic={me?.canPublishPublic ?? false}
              audience={audience}
              onChoice={(choice) => setAudience({ ...defaultCreateAudience(), choice })}
              onListed={(listed) => setAudience((current) => ({ ...current, listed }))}
              onRequirePassword={(requirePassword) =>
                setAudience((current) => ({
                  ...current,
                  requirePassword,
                  password: requirePassword ? current.password : "",
                }))
              }
              onPassword={(password) => setAudience((current) => ({ ...current, password }))}
            />
          )}
        </div>
        <details className="space-y-5 border-t border-border pt-5">
          <summary className="cursor-pointer text-sm font-medium text-fg">
            Optional settings
          </summary>
          <div className="grid gap-6 lg:grid-cols-2">
            <SlugField
              key={formKey}
              canvasId={pendingRef.current?.canvas.id}
              initialValue={formKey === 0 ? recovered?.slug : ""}
              instance={me ? { urlMode: me.urlMode, baseUrl: me.baseUrl } : undefined}
              onResolved={setSlug}
            />
            <Toggle
              label="Enable backend (optional)"
              description="Add data, files, AI, and realtime. Off by default. You can change this later in Backend."
              checked={backendEnabled}
              onChange={setBackendEnabled}
            />
          </div>
        </details>
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-4 border-t border-border bg-canvas py-4">
          <Button
            onClick={
              method === "api"
                ? createApiOnly
                : method === "paste"
                  ? createPaste
                  : () => upload && createWithUpload(upload.kind, upload.files)
            }
            loading={busy}
            disabled={
              blocked || (method === "paste" ? !html.trim() : method === "upload" ? !upload : false)
            }
          >
            {method === "api" ? (
              <>
                <Key size={16} aria-hidden />
                Create canvas
              </>
            ) : (
              <>
                Create draft
                <ArrowRight size={16} aria-hidden />
              </>
            )}
          </Button>
          <p className="text-xs text-muted">
            Start another way:{" "}
            <a
              href="/gallery?templatable=true"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              find a template
            </a>{" "}
            ·{" "}
            <a
              href="/docs/agents/mcp"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              connect an agent
            </a>
          </p>
        </div>
      </fieldset>
      {hasInput && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
          <p>
            Preparation is kept while navigating this tab. Reloading requires reselecting files;
            passwords are cleared when you leave.
          </p>
          <Button variant="ghost" size="sm" disabled={busy} onClick={discardInput}>
            Discard preparation
          </Button>
        </div>
      )}
      <Dialog
        open={blocker.status === "blocked"}
        onClose={() => blocker.reset?.()}
        title="Leave this preparation?"
        dismissable={!busy}
      >
        <p className="text-sm text-muted">
          Your title, HTML and selected files stay in this tab until you return. Passwords are
          cleared. Reloading or closing the tab loses this unsaved preparation.
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => blocker.reset?.()}>
            Keep preparing
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              discardInput();
              blocker.proceed?.();
            }}
          >
            Discard and leave
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setAudience((current) => ({ ...current, password: "" }));
              blocker.proceed?.();
            }}
          >
            Keep preparation and leave
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function CreateAudience({
  workspaceName,
  canPublishPublic,
  audience,
  onChoice,
  onListed,
  onRequirePassword,
  onPassword,
}: {
  workspaceName?: string;
  canPublishPublic: boolean;
  audience: CreateAudienceState;
  onChoice: (choice: CreateAudienceChoice) => void;
  onListed: (listed: boolean) => void;
  onRequirePassword: (required: boolean) => void;
  onPassword: (password: string) => void;
}) {
  const widerChoice: CreateAudienceChoice = workspaceName ? "workspace" : "public";
  const widerLabel = workspaceName ? `Everyone in ${workspaceName}` : "Public link";
  const publicDisabled = !workspaceName && !canPublishPublic;

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-fg">Audience</h2>
        <p className="text-xs text-muted">Choose who can open this canvas after it publishes.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {[
          {
            value: "private" as const,
            label: "Restricted",
            description: "Only you and people or teams you add can open it.",
            disabled: false,
          },
          {
            value: widerChoice,
            label: widerLabel,
            description: workspaceName
              ? "Anyone in this workspace with the link can open it."
              : "Anyone with the link can open it.",
            disabled: publicDisabled,
          },
        ].map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex cursor-pointer gap-3 rounded-lg border px-3 py-3",
              audience.choice === option.value
                ? "border-accent/45 bg-accent-subtle/70"
                : "border-border bg-surface",
              option.disabled && "cursor-not-allowed opacity-55",
            )}
          >
            <input
              type="radio"
              aria-label={option.label}
              name="create-audience"
              value={option.value}
              checked={audience.choice === option.value}
              disabled={option.disabled}
              onChange={() => onChoice(option.value)}
              className="mt-0.5 size-4 accent-[var(--color-accent)]"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-fg">{option.label}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </div>

      {publicDisabled && (
        <p className="text-xs text-muted">Public links are unavailable for your account.</p>
      )}

      {audience.choice === "workspace" && (
        <label className="flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5">
          <input
            type="checkbox"
            aria-label="List in Shared"
            checked={audience.listed}
            onChange={(event) => onListed(event.target.checked)}
            className="mt-0.5 size-4 accent-[var(--color-accent)]"
          />
          <span>
            <span className="block text-sm font-medium text-fg">List in Shared</span>
            <span className="block text-xs text-muted">
              Help workspace members find it without changing who has access.
            </span>
          </span>
        </label>
      )}

      {audience.choice === "public" && (
        <div className="space-y-3 rounded-lg border border-border bg-surface px-3 py-2.5">
          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              aria-label="Require password"
              checked={audience.requirePassword}
              onChange={(event) => onRequirePassword(event.target.checked)}
              className="mt-0.5 size-4 accent-[var(--color-accent)]"
            />
            <span>
              <span className="block text-sm font-medium text-fg">Require password</span>
              <span className="block text-xs text-muted">
                Visitors enter this password before the canvas opens.
              </span>
            </span>
          </label>
          {audience.requirePassword && (
            <Field
              label="Password"
              type="password"
              value={audience.password}
              onChange={(event) => onPassword(event.target.value)}
              placeholder="Enter a password"
              autoComplete="new-password"
            />
          )}
        </div>
      )}
    </section>
  );
}

/** The "Use the API" path, surfaced as a distinct agent/script flow. Before the
 *  canvas exists we can't show a real key, so we preview the deploy shape (a
 *  placeholder id/key against the instance origin) so an agent/script author can
 *  see exactly what they'll get; creating then reveals the real one-time key. */
function ApiPathIntro({
  me,
  slug,
}: {
  me?: { urlMode: "path" | "subdomain"; baseUrl: string };
  slug: string;
}) {
  const origin = me ? new URL(me.baseUrl).origin : "https://your-instance.example";
  const previewUrl = `${origin}/c/${slug || "<id>"}`;
  const preview = deployCurl({ url: previewUrl, id: "<canvas-id>", apiKey: "<secret-key>" });
  return (
    <div className="space-y-4 rounded-xl border border-border bg-surface-sunken p-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-fg">The agent &amp; script path</p>
        <p className="text-sm leading-relaxed text-muted">
          Creates an empty canvas and shows a secret key <strong>once</strong>. Deploy to it from
          CI, a script, or an AI agent with{" "}
          <code className="font-mono text-xs">PUT /v1/canvases/:id/deploy</code>.
        </p>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">
            What you'll run
          </p>
          <CopyButton value={preview} label="Copy" toastMessage="Snippet copied" />
        </div>
        <CodeBox value={preview} variant="block" />
        <p className="text-xs text-muted">
          Your real canvas id and one-time key are filled in after you create the key below.
        </p>
      </div>
    </div>
  );
}

function ApiSnippet({
  result,
  onDone,
}: {
  result: { id: string; apiKey: string; url: string };
  onDone: () => void;
}) {
  const snippet = deployCurl({ url: result.url, id: result.id, apiKey: result.apiKey });
  return (
    <div className="space-y-5">
      {/* The key is shown once, here. Navigating away forfeits it (regenerate to recover). */}
      <div className="space-y-2">
        <p className="text-sm font-semibold text-fg">Your secret key (shown once)</p>
        <CodeBox value={result.apiKey} copy copyToast="Key copied" />
        <p className="text-xs text-muted">
          Store it now. It cannot be shown again. Lost it? Regenerate in canvas settings.
        </p>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-fg">Deploy with the API</p>
          <CopyButton value={snippet} label="Copy" toastMessage="Snippet copied" />
        </div>
        <CodeBox value={snippet} variant="block" />
      </div>
      <Button onClick={onDone}>Go to canvas</Button>
    </div>
  );
}
