import { useNavigate } from "@tanstack/react-router";
import { CopyButton } from "../components/CopyButton.js";

const AGENT_SNIPPET = `# Deploy to canvas-drop
# 1. Create a canvas in the dashboard ("Use the API") to get its URL + key.
# 2. Build static files (HTML/CSS/JS — no build step needed).
# 3. Deploy the folder as a zip with the canvas's secret key:

curl -X PUT "<your-canvas-url>/../v1/canvases/<canvas-id>/deploy" \\
  -H "Authorization: Bearer <cd_secret_key>" \\
  --data-binary @site.zip

# The browser SDK (global \`canvasdrop\`) is available in every canvas:
#   canvasdrop.kv.get/set · canvasdrop.files.upload · canvasdrop.ai.chat · canvasdrop.me()`;

function PathCard({
  step,
  title,
  body,
  cta,
  onClick,
}: {
  step: string;
  title: string;
  body: string;
  cta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-start gap-2 rounded-xl border border-border bg-surface p-5 text-left transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:border-accent hover:bg-accent-subtle/40"
    >
      <span className="font-mono text-xs text-subtle">{step}</span>
      <span className="text-sm font-semibold text-fg">{title}</span>
      <span className="text-sm text-muted">{body}</span>
      <span className="mt-1 text-[0.8125rem] font-medium text-accent">{cta} →</span>
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
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Ship your first canvas</h1>
        <p className="max-w-xl text-muted">
          A canvas is a small web artifact on its own URL — paste some HTML, upload files or a
          folder, or deploy from the API. Pick the fastest path; you can change everything later.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <PathCard
          step="01 · fastest"
          title="Paste HTML"
          body="Paste a snippet and get a live URL in seconds."
          cta="Paste"
          onClick={() => go("paste")}
        />
        <PathCard
          step="02"
          title="Files, folder, or ZIP"
          body="Drag in files or a whole folder, exactly as they are."
          cta="Upload"
          onClick={() => go("folder")}
        />
        <PathCard
          step="03 · for agents"
          title="Use the API"
          body="Get a key and deploy programmatically or with an AI agent."
          cta="Get a key"
          onClick={() => go("api")}
        />
      </div>

      <section className="space-y-3 rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Build with an AI agent</h2>
          <CopyButton value={AGENT_SNIPPET} label="Copy snippet" toastMessage="Snippet copied" />
        </div>
        <pre className="overflow-x-auto rounded-lg bg-canvas p-4 font-mono text-xs leading-relaxed text-muted">
          {AGENT_SNIPPET}
        </pre>
      </section>
    </div>
  );
}
