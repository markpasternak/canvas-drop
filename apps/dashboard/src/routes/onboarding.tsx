import { Code, FileHtml, FolderOpen } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CopyButton } from "../components/CopyButton.js";
import { PageHeader, Panel } from "../components/Surface.js";

const AGENT_SNIPPET = `# Deploy to Canvasdrop
# 1. Create a canvas in the dashboard ("Use the API") to get its ID + secret key.
# 2. Build static files (HTML/CSS/JS, no build step needed).
# 3. Deploy the folder as a zip with the canvas's secret key:

curl -X PUT "<app-url>/v1/canvases/<canvas-id>/deploy" \\
  -H "Authorization: Bearer <cd_secret_key>" \\
  --data-binary @site.zip

# The browser SDK (global \`canvasdrop\`) is available in every canvas:
#   canvasdrop.kv.get/set, canvasdrop.files.upload, canvasdrop.ai.chat, canvasdrop.me()`;

function PathCard({
  icon,
  label,
  title,
  body,
  cta,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  body: string;
  cta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-40 flex-col items-start gap-3 rounded-xl border border-border bg-surface p-5 text-left shadow-[var(--shadow-panel)] transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:border-accent hover:bg-surface-raised"
    >
      <span className="grid size-9 place-items-center rounded-lg border border-border bg-surface-sunken text-subtle group-hover:text-accent">
        {icon}
      </span>
      <span className="text-xs font-medium text-subtle">{label}</span>
      <span className="text-sm font-semibold text-fg">{title}</span>
      <span className="text-sm text-muted">{body}</span>
      <span className="mt-auto text-[0.8125rem] font-medium text-accent">{cta}</span>
    </button>
  );
}

/** First-run page (§6.9.9): the three fastest paths to a live URL + the agent
 * snippet. Auto-shown to zero-canvas users (from the list), and reachable at
 * /onboarding directly. */
export default function Onboarding() {
  const navigate = useNavigate();
  const go = (method: string) => navigate({ to: "/new", search: { method } });

  return (
    <div className="max-w-5xl space-y-8">
      <PageHeader
        title="Ship your first canvas"
        description={
          <>
            A canvas is a small web artifact on its own URL. Start from a snippet, local files, or
            an API deploy &mdash; or read the{" "}
            <a href="/docs/quickstart" className="font-medium text-accent hover:underline">
              Quickstart guide ↗
            </a>
            .
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <PathCard
          icon={<FileHtml size={18} weight="duotone" aria-hidden />}
          label="Fastest path"
          title="Paste HTML"
          body="Paste a snippet and get a live URL in seconds."
          cta="Paste"
          onClick={() => go("paste")}
        />
        <PathCard
          icon={<FolderOpen size={18} weight="duotone" aria-hidden />}
          label="Static files"
          title="Files, folder, or ZIP"
          body="Drag in files or a whole folder, exactly as they are."
          cta="Upload"
          onClick={() => go("folder")}
        />
        <PathCard
          icon={<Code size={18} weight="duotone" aria-hidden />}
          label="Programmatic"
          title="Use the API"
          body="Get a key and deploy programmatically or with an AI agent."
          cta="Get a key"
          onClick={() => go("api")}
        />
      </div>

      <Panel className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Build with an AI agent</h2>
          <CopyButton value={AGENT_SNIPPET} label="Copy snippet" toastMessage="Snippet copied" />
        </div>
        <pre className="overflow-x-auto rounded-lg bg-surface-sunken p-4 font-mono text-xs leading-relaxed text-muted">
          {AGENT_SNIPPET}
        </pre>
      </Panel>
    </div>
  );
}
