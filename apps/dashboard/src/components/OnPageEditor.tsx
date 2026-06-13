import { useEffect, useRef } from "react";

export interface OnPageEditorProps {
  canvasId: string;
  /** The single HTML file the on-page edits are saved to. */
  htmlPath: string;
  saving: boolean;
  /** Called (debounced by the in-page shim) with the cleaned, edited HTML. */
  onSave: (html: string) => void;
}

/**
 * On-page text editing (M5 polish): the draft's single HTML page rendered editable
 * in the sandboxed preview iframe (`?edit=1` injects the shim server-side). The user
 * clicks any text and edits it; the shim posts the cleaned HTML back, which we save
 * to the HTML file. `sandbox="allow-scripts"` (no `allow-same-origin`) keeps the page
 * in an opaque origin — it can postMessage to us but can't touch the dashboard session.
 */
export function OnPageEditor({ canvasId, htmlPath, saving, onSave }: OnPageEditorProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  // Fixed src (no refresh key) so saving never reloads the page mid-edit.
  const src = `/api/canvases/${canvasId}/preview/?edit=1`;

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Validate by source window, not origin — the sandboxed iframe is opaque ("null").
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data as { type?: string; html?: string };
      if (data?.type === "cd-onpage" && typeof data.html === "string") {
        onSaveRef.current(data.html);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-subtle">
          Editing on the page · <span className="font-mono">{htmlPath}</span>
        </span>
        <span className="shrink-0 text-xs text-subtle">
          {saving ? "Saving…" : "Click any text to edit"}
        </span>
      </div>
      <iframe
        key={htmlPath}
        ref={iframeRef}
        title="On-page editor"
        src={src}
        sandbox="allow-scripts allow-forms"
        className="h-full w-full rounded-md border border-border bg-white"
      />
    </div>
  );
}
