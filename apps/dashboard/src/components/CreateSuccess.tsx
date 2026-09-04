import { ArrowSquareOut, CheckCircle } from "@phosphor-icons/react";
import { Button } from "./Button.js";
import { CodeBox } from "./CodeBox.js";
import { InlineNotice, PageHeader } from "./Surface.js";

export interface PublishedCanvasResult {
  id: string;
  url: string;
  apiKey: string;
  audience: string;
  shareFailed: boolean;
}

/** Key stays in this mounted result only. Opening the canvas or Share in a new
 * tab keeps the one-time reveal available until the explicit save/skip choice. */
export function CreateSuccess({
  result,
  onDone,
}: {
  result: PublishedCanvasResult;
  onDone: () => void;
}) {
  return (
    <div className="mx-auto max-w-3xl space-y-7 py-4">
      <CheckCircle size={36} weight="duotone" className="text-accent" aria-hidden />
      <PageHeader title="Your canvas is published" description={result.audience} />
      {result.shareFailed && (
        <InlineNotice tone="warning">
          Your canvas is published. Sharing couldn’t be confirmed. Open Share to check who can
          access it before distributing the link.
        </InlineNotice>
      )}
      <div className="space-y-4">
        <CodeBox value={result.url} copy copyLabel="Copy link" copyToast="Canvas link copied" />
        <div className="flex flex-wrap gap-5 text-sm">
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 font-medium text-accent hover:underline"
          >
            Open canvas <ArrowSquareOut size={16} aria-label="in a new tab" />
          </a>
          <a
            href={`/canvases/${result.id}/share`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-muted hover:text-fg"
          >
            Manage sharing <ArrowSquareOut size={16} aria-label="in a new tab" />
          </a>
        </div>
      </div>
      <div className="space-y-4 border-t border-border pt-6">
        <p className="text-sm text-muted">
          You only need a deploy key for API deployments. Save it now, or continue without it. You
          can generate a replacement in Settings later.
        </p>
        <details className="space-y-4">
          <summary className="cursor-pointer text-sm font-medium text-fg">
            Save your deploy key (shown once)
          </summary>
          <CodeBox value={result.apiKey} copy copyLabel="Copy key" copyToast="Key copied" />
          <Button onClick={onDone}>I’ve saved the key</Button>
        </details>
        <Button variant="secondary" onClick={onDone}>
          {result.shareFailed
            ? "Continue without saving · Open Share"
            : "Continue without saving the key"}
        </Button>
      </div>
    </div>
  );
}
