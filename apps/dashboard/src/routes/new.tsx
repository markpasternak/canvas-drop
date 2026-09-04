import { ArrowRight, Code, FileHtml, FolderOpen, type Icon, Key } from "@phosphor-icons/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import { CodeBox } from "../components/CodeBox.js";
import { CopyButton } from "../components/CopyButton.js";
import { CreatePreview, createDocumentPreview } from "../components/CreatePreview.js";
import { CreateSuccess, type PublishedCanvasResult } from "../components/CreateSuccess.js";
import {
  canvasRelativePaths,
  FileDropOrProgress,
  folderFormFromFiles,
  rawUploadPath,
} from "../components/DeployFiles.js";
import { Field, TextareaField } from "../components/Field.js";
import { SlugField } from "../components/SlugField.js";
import { InlineNotice, PageHeader } from "../components/Surface.js";
import { Toggle } from "../components/Toggle.js";
import { ApiError, api } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import {
  applyCreateAudience,
  type CreateAudienceChoice,
  type CreateAudienceState,
  defaultCreateAudience,
  resetAudienceForDestination,
} from "../lib/create-audience.js";
import { deployCurl } from "../lib/deploy-curl.js";
import { useMe } from "../lib/queries.js";
import type { SlugStatus } from "../lib/use-slug-availability.js";

type Method = "paste" | "upload" | "api";
type SelectedUpload = { kind: "folder" | "zip"; files: File[]; paths: string[] };
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
  const search = useSearch({ strict: false }) as { method?: string };
  const navigate = useNavigate();

  const initial =
    search.method === "folder" || search.method === "zip"
      ? "upload"
      : (METHODS.find((m) => m.id === search.method)?.id ?? "paste");
  const [method, setMethod] = useState<Method>(initial);
  const [title, setTitle] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  // Optional custom slug (plan 004). `slug` is the cosmetic-normalized value; `status`
  // gates submit — blocked when a slug is entered but not confirmed available.
  const meQuery = useMe();
  const me = meQuery.data;
  const busyRef = useRef(false);
  const [slug, setSlug] = useState<{ slug: string; status: SlugStatus }>({
    slug: "",
    status: "idle",
  });
  const slugBlocked = slug.slug !== "" && slug.status !== "available";
  // Home tenant for the new canvas (plan 002 U6). Personal (null) or one of the caller's
  // orgs. `undefined` = not explicitly chosen → fall back to the members-default-Org rule.
  // The server re-validates against the caller's membership regardless (never trusts this).
  const orgs = me?.orgs ?? [];
  const [workspace, setWorkspace] = useState<string | null | undefined>(undefined);
  // Default selection: a member of exactly one org lands in it; everyone else is Personal.
  const homeOrgId = workspace === undefined ? (orgs.length === 1 ? orgs[0]?.id : null) : workspace;
  // Backend-group master switch chosen at create time (plan 006). Off by default;
  // changeable later in the canvas Backend tab.
  const [backendEnabled, setBackendEnabled] = useState(false);
  const [audience, setAudience] = useState(defaultCreateAudience);
  const [html, setHtml] = useState("");
  const [upload, setUpload] = useState<SelectedUpload | null>(null);
  const preview = useMemo(
    () => (method === "paste" ? createDocumentPreview(html) : null),
    [html, method],
  );
  const canvasTitle = titleEdited ? title : (preview?.title ?? "");
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Upload progress: null = not uploading; 0-100 = % of bytes sent (100 = sent,
  // server now extracting/publishing).
  const [progress, setProgress] = useState<number | null>(null);

  const [revealed, setRevealed] = useState<PublishedCanvasResult | null>(null);
  const [apiResult, setApiResult] = useState<{ id: string; apiKey: string; url: string } | null>(
    null,
  );

  function fail(err: unknown) {
    busyRef.current = false;
    setError(err instanceof ApiError ? err.hint : "Something went wrong. Try again.");
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

  async function revealPublished(id: string, apiKey: string, url: string) {
    const outcome = await applyCreateAudience(id, audience, api.updateSettings);
    setBusy(false);
    setProgress(null);
    const shareFailed = outcome.kind === "failed";
    const access = shareFailed
      ? "Check sharing before distributing the link"
      : audience.choice === "private"
        ? "Restricted · Only you can open it"
        : audience.choice === "workspace"
          ? `Everyone in ${orgs.find((org) => org.id === homeOrgId)?.name ?? "your workspace"}`
          : `Public link · Anyone with the link${audience.requirePassword ? " and password" : ""}`;
    setRevealed({ apiKey, id, url, audience: access, shareFailed });
  }

  async function createPaste() {
    if (busyRef.current || !html.trim() || meQuery.isPending || meQuery.isError) return;
    if (slugBlocked) {
      setError("Pick an available slug, or clear it for a random one.");
      return;
    }
    if (!validateAudience()) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await api.pasteHtml({
        html,
        title: canvasTitle || undefined,
        backendEnabled,
        slug: slug.slug || undefined,
        orgId: homeOrgId,
      });
      await revealPublished(res.id, res.apiKey, res.url);
    } catch (err) {
      fail(err);
    }
  }

  async function createWithUpload(kind: "folder" | "zip", files: File[]) {
    if (busyRef.current || meQuery.isPending || meQuery.isError) return;
    if (files.length === 0) return;
    if (slugBlocked) {
      setError("Pick an available slug, or clear it for a random one.");
      return;
    }
    if (!validateAudience()) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setProgress(0);
    const onProgress = (f: number) => setProgress(Math.round(f * 100));
    try {
      const canvas = await api.createCanvas({
        title: canvasTitle || undefined,
        backendEnabled,
        slug: slug.slug || undefined,
        orgId: homeOrgId,
      });
      try {
        if (kind === "folder") {
          await api.deployFolder(canvas.id, folderFormFromFiles(files), onProgress);
        } else {
          const first = files[0];
          if (!first) return;
          await api.deployZip(canvas.id, await first.arrayBuffer(), onProgress);
        }
      } catch (deployErr) {
        // Deploy failed after the canvas was created. Soft-delete the orphan so
        // the user isn't left with an empty canvas + a forfeited key (mirrors the
        // server-side /paste cleanup). Then surface the deploy error for retry.
        await api.deleteCanvas(canvas.id).catch(() => {});
        throw deployErr;
      }
      await revealPublished(canvas.id, canvas.apiKey, canvas.url);
    } catch (err) {
      fail(err);
    }
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
  const blocked =
    slugBlocked || (method !== "api" && audienceBlocked) || meQuery.isPending || meQuery.isError;
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

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Create a canvas"
        description="Start with something you’ve made. Give it a home and a link."
      />
      {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      {meQuery.isError && (
        <InlineNotice tone="danger">
          Workspace information couldn’t load.{" "}
          <button type="button" className="underline" onClick={() => meQuery.refetch()}>
            Try again
          </button>
        </InlineNotice>
      )}
      <fieldset disabled={busy} className="min-w-0 space-y-7 border-0 p-0" aria-busy={busy}>
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
                      ? "The archive will be checked and unpacked when you publish."
                      : "Files are staged here. Nothing has been uploaded yet."}{" "}
                    Preview the full site in the editor after creating it.
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
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5">
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
                Create key
              </>
            ) : (
              <>
                Create and publish
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
        <h3 className="text-sm font-semibold text-fg">Audience</h3>
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
