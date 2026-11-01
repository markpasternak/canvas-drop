import { ArrowRight, ArrowSquareOut, Code, FileHtml, FolderOpen } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CopyButton } from "../components/CopyButton.js";
import { PageHeader } from "../components/Surface.js";

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
  title,
  body,
  cta,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  cta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-28 w-full flex-col items-start gap-2 border-b border-border py-4 text-left transition-colors hover:bg-surface-hover"
    >
      <span className="grid size-9 place-items-center rounded-lg border border-border bg-surface-sunken text-subtle transition-colors duration-100 [transition-timing-function:var(--ease-out)] group-hover:text-accent">
        {icon}
      </span>
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
            your agent &mdash; or read the{" "}
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

      <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr]">
        <section
          className="space-y-5 rounded-xl border border-border bg-surface p-6"
          aria-labelledby="connect-agent-title"
        >
          <Code size={28} className="text-accent" aria-hidden />
          <h2 id="connect-agent-title" className="font-display text-h2 text-fg">
            Connect your agent
          </h2>
          <p className="max-w-prose text-sm leading-relaxed text-muted">
            Connect a compatible AI agent once through MCP. It can create canvases, work on drafts
            and publish with your account’s permissions.
          </p>
          <a
            href="/docs/agents/mcp"
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            Connect your agent <ArrowRight size={16} aria-hidden />
          </a>
          <p className="text-xs text-muted">
            You approve sign-in through the configured account flow. No canvas deploy key is needed.
          </p>
        </section>
        <section
          className="space-y-3 rounded-xl border border-border bg-surface p-5"
          aria-label="Creation paths"
        >
          <h2 className="font-display text-h2 text-fg">Already have something?</h2>
          <PathCard
            icon={<FileHtml size={18} aria-hidden />}
            title="Paste HTML"
            body="Start with a page or snippet. Review the draft before publishing."
            cta="Paste HTML"
            onClick={() => go("paste")}
          />
          <PathCard
            icon={<FolderOpen size={18} aria-hidden />}
            title="Files, folder, or ZIP"
            body="Keep your file structure and preview an unpublished draft."
            cta="Upload files"
            onClick={() => go("folder")}
          />
        </section>
      </div>
      <details className="space-y-4 border-t border-border pt-5">
        <summary className="cursor-pointer text-sm font-medium">Deploy from a script or CI</summary>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-prose text-sm text-muted">
            Create a canvas to get its ID and one-time deploy key. The API publishes a live version
            on each deploy.
          </p>
          <button
            type="button"
            onClick={() => go("api")}
            className="min-h-11 rounded-md border border-border px-4 text-sm hover:bg-surface-hover"
          >
            Create a canvas for the API
          </button>
          <CopyButton value={AGENT_SNIPPET} label="Copy snippet" toastMessage="Snippet copied" />
        </div>
        <pre className="overflow-x-auto rounded-lg border border-border bg-surface-sunken p-4 font-mono text-xs leading-relaxed text-muted">
          {AGENT_SNIPPET}
        </pre>
      </details>
    </div>
  );
}
