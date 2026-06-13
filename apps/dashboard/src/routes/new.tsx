import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { ApiKeyReveal } from "../components/ApiKeyReveal.js";
import { Button } from "../components/Button.js";
import { CopyButton } from "../components/CopyButton.js";
import { Field, TextareaField } from "../components/Field.js";
import { ApiError, api } from "../lib/api.js";
import { cn } from "../lib/cn.js";

type Method = "paste" | "folder" | "zip" | "api";
const METHODS: { id: Method; label: string; blurb: string }[] = [
  { id: "paste", label: "Paste HTML", blurb: "Fastest — live in seconds" },
  { id: "folder", label: "Drop a folder", blurb: "Upload static files" },
  { id: "zip", label: "Upload a ZIP", blurb: "A zipped site" },
  { id: "api", label: "Use the API", blurb: "Deploy programmatically" },
];

/** Build multipart form from a directory picker, keying each file by its path
 * relative to the canvas root (the selected top folder is stripped). */
function folderForm(files: FileList): FormData {
  const form = new FormData();
  for (const file of Array.from(files)) {
    const rel = file.webkitRelativePath || file.name;
    const path = rel.includes("/") ? rel.slice(rel.indexOf("/") + 1) : rel;
    form.set(path, file);
  }
  return form;
}

export default function CreateCanvas() {
  const search = useSearch({ strict: false }) as { method?: string };
  const navigate = useNavigate();

  const initial = (METHODS.find((m) => m.id === search.method)?.id ?? "paste") as Method;
  const [method, setMethod] = useState<Method>(initial);
  const [title, setTitle] = useState("");
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function createWithUpload(kind: "folder" | "zip", files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const canvas = await api.createCanvas({ title: title || undefined });
      try {
        if (kind === "folder") {
          await api.deployFolder(canvas.id, folderForm(files));
        } else {
          const first = files[0];
          if (!first) return;
          await api.deployZip(canvas.id, await first.arrayBuffer());
        }
      } catch (deployErr) {
        // Deploy failed after the canvas was created — soft-delete the orphan so
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

  return (
    <div className="mx-auto max-w-2xl space-y-7">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Create a canvas</h1>
        <p className="text-sm text-muted">Name it (optional), then pick how to add your files.</p>
      </header>

      <Field
        label="Title"
        hint="optional"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="My prototype"
        maxLength={200}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              setMethod(m.id);
              setError(null);
              setApiResult(null);
            }}
            className={cn(
              "rounded-lg border p-3 text-left transition-colors duration-100 [transition-timing-function:var(--ease-out)]",
              method === m.id
                ? "border-accent bg-accent-subtle/50"
                : "border-border bg-surface hover:border-border-strong",
            )}
          >
            <span className="block text-sm font-medium text-fg">{m.label}</span>
            <span className="mt-0.5 block text-xs text-muted">{m.blurb}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-border bg-surface p-5">
        {method === "paste" && (
          <div className="space-y-4">
            <TextareaField
              label="HTML"
              mono
              rows={10}
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              placeholder="<!doctype html>\n<h1>Hello</h1>"
            />
            <Button onClick={createPaste} loading={busy} disabled={!html.trim()}>
              Create & deploy
            </Button>
          </div>
        )}

        {method === "folder" && (
          <FileDrop
            label="Choose a folder of static files"
            directory
            busy={busy}
            onPick={(files) => createWithUpload("folder", files)}
          />
        )}

        {method === "zip" && (
          <FileDrop
            label="Choose a .zip of your site"
            accept=".zip"
            busy={busy}
            onPick={(files) => createWithUpload("zip", files)}
          />
        )}

        {method === "api" &&
          (apiResult ? (
            <ApiSnippet result={apiResult} onDone={() => finish(apiResult.id, false)} />
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted">
                Creates an empty canvas and shows a secret key once. Deploy to it with{" "}
                <code className="font-mono text-xs">PUT /v1/canvases/:id/deploy</code> or an AI
                agent.
              </p>
              <Button onClick={createApiOnly} loading={busy}>
                Create & get a key
              </Button>
            </div>
          ))}
      </div>

      {/* Key reveal for paste/folder/zip — on dismiss, go to the live canvas. */}
      {revealed && (
        <ApiKeyReveal
          apiKey={revealed.apiKey}
          onClose={() => finish(revealed.id, revealed.deployed)}
        />
      )}
    </div>
  );
}

function FileDrop({
  label,
  accept,
  directory,
  busy,
  onPick,
}: {
  label: string;
  accept?: string;
  directory?: boolean;
  busy: boolean;
  onPick: (files: FileList | null) => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong bg-canvas px-6 py-12 text-center transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:border-accent",
        busy && "pointer-events-none opacity-60",
      )}
    >
      <span className="text-sm font-medium text-fg">{label}</span>
      <span className="text-xs text-muted">{busy ? "Deploying…" : "Click to browse"}</span>
      <input
        type="file"
        accept={accept}
        multiple
        className="hidden"
        // webkitdirectory is non-standard; cast on the element.
        {...(directory ? { webkitdirectory: "" } : {})}
        onChange={(e) => onPick(e.target.files)}
      />
    </label>
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
        <div className="flex items-center gap-2 rounded-lg border border-border bg-canvas p-3">
          <code className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{result.apiKey}</code>
          <CopyButton value={result.apiKey} label="Copy" toastMessage="Key copied" />
        </div>
        <p className="text-xs text-muted">
          Store it now — it can't be shown again. Lost it? Regenerate in the canvas settings.
        </p>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-fg">Deploy with the API</p>
          <CopyButton value={snippet} label="Copy" toastMessage="Snippet copied" />
        </div>
        <pre className="overflow-x-auto rounded-lg bg-canvas p-4 font-mono text-xs text-muted">
          {snippet}
        </pre>
      </div>
      <Button onClick={onDone}>Go to canvas</Button>
    </div>
  );
}
