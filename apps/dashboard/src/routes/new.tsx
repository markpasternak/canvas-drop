import {
  ArrowRight,
  Code,
  FileArchive,
  FileHtml,
  FolderOpen,
  type Icon,
  Key,
} from "@phosphor-icons/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { ApiKeyReveal } from "../components/ApiKeyReveal.js";
import { Button } from "../components/Button.js";
import { CodeBox } from "../components/CodeBox.js";
import { CopyButton } from "../components/CopyButton.js";
import { FileDropOrProgress, folderFormFromFiles } from "../components/DeployFiles.js";
import { Field, TextareaField } from "../components/Field.js";
import { SlugField } from "../components/SlugField.js";
import { InlineNotice, PageHeader, Panel } from "../components/Surface.js";
import { Toggle } from "../components/Toggle.js";
import { ApiError, api } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { deployCurl } from "../lib/deploy-curl.js";
import { useMe } from "../lib/queries.js";
import type { SlugStatus } from "../lib/use-slug-availability.js";

type Method = "paste" | "folder" | "zip" | "api";
type MethodConfig = {
  id: Method;
  label: string;
  blurb: string;
  panelTitle: string;
  panelDescription: string;
  icon: Icon;
};

const METHODS = [
  {
    id: "paste",
    label: "Paste HTML",
    blurb: "Fastest for snippets",
    panelTitle: "Paste HTML and publish",
    panelDescription:
      "Drop in a single HTML document. canvas-drop creates the canvas and publishes it.",
    icon: FileHtml,
  },
  {
    id: "folder",
    label: "Files or folder",
    blurb: "Best for static sites",
    panelTitle: "Upload local files",
    panelDescription: "Drag files or a folder. Relative paths are preserved at the canvas root.",
    icon: FolderOpen,
  },
  {
    id: "zip",
    label: "Upload ZIP",
    blurb: "One packaged site",
    panelTitle: "Ship a ZIP archive",
    panelDescription: "Upload a ZIP when your site is already bundled and ready to serve.",
    icon: FileArchive,
  },
  {
    id: "api",
    label: "Use the API",
    blurb: "For agents and scripts",
    panelTitle: "Create an API target",
    panelDescription: "Generate a canvas and one-time secret key for programmatic deploys.",
    icon: Code,
  },
] satisfies [MethodConfig, ...MethodConfig[]];

export default function CreateCanvas() {
  const search = useSearch({ strict: false }) as { method?: string };
  const navigate = useNavigate();

  const initial = (METHODS.find((m) => m.id === search.method)?.id ?? "paste") as Method;
  const [method, setMethod] = useState<Method>(initial);
  const [title, setTitle] = useState("");
  // Optional custom slug (plan 004). `slug` is the cosmetic-normalized value; `status`
  // gates submit — blocked when a slug is entered but not confirmed available.
  const me = useMe().data;
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
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Upload progress: null = not uploading; 0-100 = % of bytes sent (100 = sent,
  // server now extracting/publishing).
  const [progress, setProgress] = useState<number | null>(null);

  // Post-create state: key to reveal, and where to go on dismiss.
  const [revealed, setRevealed] = useState<{
    apiKey: string;
    id: string;
    deployed: boolean;
  } | null>(null);
  const [apiResult, setApiResult] = useState<{ id: string; apiKey: string; url: string } | null>(
    null,
  );

  function fail(err: unknown) {
    setError(err instanceof ApiError ? err.hint : "Something went wrong. Try again.");
    setBusy(false);
    setProgress(null);
  }

  async function createPaste() {
    if (slugBlocked) {
      setError("Pick an available slug, or clear it for a random one.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.pasteHtml({
        html,
        title: title || undefined,
        backendEnabled,
        slug: slug.slug || undefined,
        orgId: homeOrgId,
      });
      setRevealed({ apiKey: res.apiKey, id: res.id, deployed: true });
    } catch (err) {
      fail(err);
    }
  }

  async function createWithUpload(kind: "folder" | "zip", files: File[]) {
    if (files.length === 0) return;
    if (slugBlocked) {
      setError("Pick an available slug, or clear it for a random one.");
      return;
    }
    setBusy(true);
    setError(null);
    setProgress(0);
    const onProgress = (f: number) => setProgress(Math.round(f * 100));
    try {
      const canvas = await api.createCanvas({
        title: title || undefined,
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
      setRevealed({ apiKey: canvas.apiKey, id: canvas.id, deployed: true });
    } catch (err) {
      fail(err);
    }
  }

  async function createApiOnly() {
    if (slugBlocked) {
      setError("Pick an available slug, or clear it for a random one.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const canvas = await api.createCanvas({
        title: title || undefined,
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

  function finish(id: string, deployed: boolean) {
    navigate({ to: "/canvases/$id", params: { id }, search: deployed ? { live: true } : {} });
  }

  const activeMethod = METHODS.find((m) => m.id === method) ?? METHODS[0];
  const ActiveIcon = activeMethod.icon;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Create a canvas"
        description="Choose a source. canvas-drop handles the URL, secret key, and first publish."
      />

      {error && <InlineNotice tone="danger">{error}</InlineNotice>}

      {/* Source-first create flow (plan U16): the source/method choice leads, then
          name/slug, then the clearly-optional backend toggle, then create/publish.
          The backend toggle deliberately no longer precedes the source choice. */}
      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <section
          className="space-y-3 rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-panel)] sm:p-5"
          aria-label="Creation method"
        >
          <h2 className="text-[0.6875rem] font-medium uppercase tracking-wide text-subtle">
            Source
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            {METHODS.map((m) => {
              const MethodIcon = m.icon;
              const active = method === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setMethod(m.id);
                    setError(null);
                    setApiResult(null);
                  }}
                  className={cn(
                    "group flex min-h-16 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all duration-100 [transition-timing-function:var(--ease-out)] active:translate-y-px",
                    active
                      ? "border-accent/45 bg-accent-subtle/75 text-fg shadow-[0_1px_3px_hsl(var(--shadow-color)/0.12)]"
                      : "border-border bg-surface-raised text-muted shadow-xs hover:border-border-strong hover:bg-surface-hover hover:text-fg",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-9 shrink-0 place-items-center rounded-lg border transition-colors duration-100 [transition-timing-function:var(--ease-out)]",
                      active
                        ? "border-accent/30 bg-surface text-accent"
                        : "border-border bg-surface-sunken text-subtle group-hover:text-accent",
                    )}
                  >
                    <MethodIcon size={18} weight="duotone" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-fg">{m.label}</span>
                    <span className="mt-0.5 block text-xs leading-snug text-muted">{m.blurb}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <Panel className="space-y-5">
          <div className="flex items-start gap-3 border-b border-border pb-5">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-accent/25 bg-accent-subtle text-accent">
              <ActiveIcon size={21} weight="duotone" aria-hidden />
            </span>
            <div className="min-w-0 space-y-1">
              <h2 className="text-base font-semibold tracking-tight text-fg">
                {activeMethod.panelTitle}
              </h2>
              <p className="max-w-xl text-sm leading-relaxed text-muted">
                {activeMethod.panelDescription}
              </p>
            </div>
          </div>

          <div className="space-y-5">
            {/* Step 2 — name & slug (after the source choice). */}
            <Field
              label="Title"
              hint="optional"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="My prototype"
              maxLength={200}
            />

            <SlugField
              instance={me ? { urlMode: me.urlMode, baseUrl: me.baseUrl } : undefined}
              onResolved={setSlug}
            />

            {/* Workspace (plan 002 U6): where this canvas lives. Only shown when the caller
                belongs to an org — a guest/personal-only user never sees it (and the server
                rejects any org they don't belong to). Drives whether `whole_org` shares it
                with the org or keeps it personal. */}
            {orgs.length > 0 && (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-fg">Workspace</span>
                <select
                  value={homeOrgId ?? ""}
                  onChange={(e) => setWorkspace(e.target.value === "" ? null : e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg shadow-xs focus:border-accent focus:outline-none"
                >
                  <option value="">Personal</option>
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
                <span className="block text-xs text-muted">
                  <strong>Personal</strong> — only you and people you specifically invite.{" "}
                  <strong>A workspace</strong> — you can later share it with everyone in that org
                  (the “Whole org” access level). This choice is fixed once the canvas is created.
                </span>
              </label>
            )}

            {/* Step 3 — optional backend capability. Deliberately after the source
                choice + naming so it reads as an optional add-on, not a gate. */}
            <div className="rounded-xl border border-border bg-surface-sunken p-4">
              <Toggle
                label="Enable backend (optional)"
                description="Let this canvas store data, serve files, call AI, and sync in realtime. Off keeps it a static page — you can change this any time in the Backend tab."
                checked={backendEnabled}
                onChange={setBackendEnabled}
              />
            </div>

            {/* Step 4 — create/publish (the source-specific action). */}
            {method === "paste" && (
              <div className="space-y-4">
                <TextareaField
                  label="HTML"
                  mono
                  rows={9}
                  value={html}
                  onChange={(e) => setHtml(e.target.value)}
                  placeholder={"<!doctype html>\n<h1>Hello</h1>"}
                />
                <Button onClick={createPaste} loading={busy} disabled={!html.trim() || slugBlocked}>
                  Create and publish
                  <ArrowRight size={16} weight="bold" aria-hidden />
                </Button>
              </div>
            )}

            {method === "folder" && (
              <FileDropOrProgress
                busy={busy}
                pct={progress}
                label="Drag files or a folder here"
                variant="folder"
                onFiles={(files) => createWithUpload("folder", files)}
              />
            )}

            {method === "zip" && (
              <FileDropOrProgress
                busy={busy}
                pct={progress}
                label="Drag a .zip here"
                variant="zip"
                onFiles={(files) => createWithUpload("zip", files)}
              />
            )}

            {method === "api" &&
              (apiResult ? (
                <ApiSnippet result={apiResult} onDone={() => finish(apiResult.id, false)} />
              ) : (
                <ApiPathIntro
                  me={me ? { urlMode: me.urlMode, baseUrl: me.baseUrl } : undefined}
                  slug={slug.slug}
                  onCreate={createApiOnly}
                  busy={busy}
                  disabled={slugBlocked}
                />
              ))}
          </div>
        </Panel>
      </div>

      {/* Key reveal for paste/folder/zip. On dismiss, go to the live canvas. */}
      {revealed && (
        <ApiKeyReveal
          apiKey={revealed.apiKey}
          onClose={() => finish(revealed.id, revealed.deployed)}
        />
      )}
    </div>
  );
}

/** The "Use the API" path, surfaced as a distinct agent/script flow. Before the
 *  canvas exists we can't show a real key, so we preview the deploy shape (a
 *  placeholder id/key against the instance origin) so an agent/script author can
 *  see exactly what they'll get; creating then reveals the real one-time key. */
function ApiPathIntro({
  me,
  slug,
  onCreate,
  busy,
  disabled,
}: {
  me?: { urlMode: "path" | "subdomain"; baseUrl: string };
  slug: string;
  onCreate: () => void;
  busy: boolean;
  disabled: boolean;
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
      <Button onClick={onCreate} loading={busy} disabled={disabled}>
        <Key size={16} weight="bold" aria-hidden />
        Create key
      </Button>
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
