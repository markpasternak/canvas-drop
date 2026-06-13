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
import { CopyButton } from "../components/CopyButton.js";
import { FileDropOrProgress, folderFormFromFiles } from "../components/DeployFiles.js";
import { Field, TextareaField } from "../components/Field.js";
import { InlineNotice, PageHeader, Panel } from "../components/Surface.js";
import { ApiError, api } from "../lib/api.js";
import { cn } from "../lib/cn.js";

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
      "Drop in a single HTML document. Canvasdrop creates the canvas and deploys it.",
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
    setBusy(true);
    setError(null);
    try {
      const res = await api.pasteHtml({ html, title: title || undefined });
      setRevealed({ apiKey: res.apiKey, id: res.id, deployed: true });
    } catch (err) {
      fail(err);
    }
  }

  async function createWithUpload(kind: "folder" | "zip", files: File[]) {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    const onProgress = (f: number) => setProgress(Math.round(f * 100));
    try {
      const canvas = await api.createCanvas({ title: title || undefined });
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
    setBusy(true);
    setError(null);
    try {
      const canvas = await api.createCanvas({ title: title || undefined });
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
        description="Choose a source. Canvasdrop handles the URL, secret key, and first publish."
      />

      {error && <InlineNotice tone="danger">{error}</InlineNotice>}

      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <section
          className="grid gap-1.5 rounded-xl border border-border bg-surface p-1.5 shadow-[var(--shadow-panel)] sm:grid-cols-2 lg:grid-cols-1"
          aria-label="Creation method"
        >
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
                    : "border-transparent bg-transparent text-muted hover:bg-surface-hover hover:text-fg",
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
            <Field
              label="Title"
              hint="optional"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="My prototype"
              maxLength={200}
            />

            {method === "paste" && (
              <div className="space-y-4">
                <TextareaField
                  label="HTML"
                  mono
                  rows={9}
                  value={html}
                  onChange={(e) => setHtml(e.target.value)}
                  placeholder="<!doctype html>\n<h1>Hello</h1>"
                />
                <Button onClick={createPaste} loading={busy} disabled={!html.trim()}>
                  Create and deploy
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
                <div className="space-y-4 rounded-xl border border-border bg-surface-sunken p-4">
                  <p className="text-sm leading-relaxed text-muted">
                    Creates an empty canvas and shows a secret key once. Deploy to it with{" "}
                    <code className="font-mono text-xs">PUT /v1/canvases/:id/deploy</code> or an AI
                    agent.
                  </p>
                  <Button onClick={createApiOnly} loading={busy}>
                    <Key size={16} weight="bold" aria-hidden />
                    Create key
                  </Button>
                </div>
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

function ApiSnippet({
  result,
  onDone,
}: {
  result: { id: string; apiKey: string; url: string };
  onDone: () => void;
}) {
  const snippet = `curl -X PUT "${new URL(result.url).origin}/v1/canvases/${result.id}/deploy" \\
  -H "Authorization: Bearer ${result.apiKey}" \\
  --data-binary @site.zip`;
  return (
    <div className="space-y-5">
      {/* The key is shown once, here. Navigating away forfeits it (regenerate to recover). */}
      <div className="space-y-2">
        <p className="text-sm font-semibold text-fg">Your secret key (shown once)</p>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken p-3">
          <code className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{result.apiKey}</code>
          <CopyButton value={result.apiKey} label="Copy" toastMessage="Key copied" />
        </div>
        <p className="text-xs text-muted">
          Store it now. It cannot be shown again. Lost it? Regenerate in canvas settings.
        </p>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-fg">Deploy with the API</p>
          <CopyButton value={snippet} label="Copy" toastMessage="Snippet copied" />
        </div>
        <pre className="overflow-x-auto rounded-lg bg-surface-sunken p-4 font-mono text-xs text-muted">
          {snippet}
        </pre>
      </div>
      <Button onClick={onDone}>Go to canvas</Button>
    </div>
  );
}
