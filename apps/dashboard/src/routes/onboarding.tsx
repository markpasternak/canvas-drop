import { ArrowRight, ArrowSquareOut, Code, FileHtml, FolderOpen } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CopyButton } from "../components/CopyButton.js";
import { PageHeader, Panel } from "../components/Surface.js";

const AGENT_SNIPPET = `# Deploy to canvas-drop
# 1. Create a canvas in the dashboard ("Use the API") to get its ID + secret key.
# 2. Build static files (HTML/CSS/JS, no build step needed).
# 3. Deploy the folder as a zip with the canvas's secret key:

curl -X PUT "<app-url>/v1/canvases/<canvas-id>/deploy" \\
  -H "Authorization: Bearer <cd_secret_key>" \\
  --data-binary @site.zip

# The browser SDK (global \`canvasdrop\`) is available in every canvas:
#   canvasdrop.kv.get/set, canvasdrop.files.upload, canvasdrop.ai.chat, canvasdrop.me()
# Deploy ships files only — the key can't enable the backend. Turn on Backend +
# the capabilities you use (kv, files, ai, realtime) in the canvas's Backend tab first.`;

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
      className="group flex min-h-32 flex-col items-start gap-2.5 rounded-lg border border-border bg-surface-raised p-4 text-left shadow-xs transition-all duration-100 [transition-timing-function:var(--ease-out)] hover:border-border-strong hover:bg-surface-hover hover:shadow-sm active:translate-y-px"
    >
      <span className="grid size-9 place-items-center rounded-lg border border-border bg-surface-sunken text-subtle transition-colors duration-100 [transition-timing-function:var(--ease-out)] group-hover:text-accent">
        {icon}
      </span>
      <span className="text-xs font-medium text-subtle">{label}</span>
      <span className="text-sm font-semibold text-fg">{title}</span>
      <span className="text-sm text-muted">{body}</span>
      <span className="mt-auto inline-flex items-center gap-1.5 text-[0.8125rem] font-medium text-accent">
        {cta}
        <ArrowRight
          size={14}
          weight="bold"
          aria-hidden
          className="transition-transform duration-100 [transition-timing-function:var(--ease-out)] group-hover:translate-x-0.5"
        />
      </span>
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
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Ship your first canvas"
        description={
          <>
            A canvas is a small web artifact on its own URL. Start from a snippet, local files, or
            an API deploy &mdash; or read the{" "}
            <a
              href="/docs/quickstart"
              className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
            >
              Quickstart guide
              <ArrowSquareOut size={13} weight="bold" aria-hidden />
            </a>
            .
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <section
          className="space-y-3 rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-panel)] sm:p-5"
          aria-label="Creation paths"
        >
          <h2 className="text-[0.6875rem] font-medium uppercase tracking-wide text-subtle">
            Pick a path
          </h2>
          <div className="grid gap-2.5 sm:grid-cols-3 lg:grid-cols-1">
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
        </section>

        <Panel className="min-w-0 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h2 className="text-base font-semibold tracking-tight text-fg">
                Build with an AI agent
              </h2>
              <p className="text-sm text-muted">
                Point your agent or script at this deploy recipe to ship a canvas hands-free.
              </p>
            </div>
            <CopyButton value={AGENT_SNIPPET} label="Copy snippet" toastMessage="Snippet copied" />
          </div>
          <pre className="overflow-x-auto rounded-lg border border-border bg-surface-sunken p-4 font-mono text-xs leading-relaxed text-muted">
            {AGENT_SNIPPET}
          </pre>
        </Panel>
      </div>
    </div>
  );
}
