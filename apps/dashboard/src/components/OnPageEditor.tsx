import { TextAa } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { PaneHeader, WorkspacePane } from "./Surface.js";

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
 * in an opaque origin. It can postMessage to us but can't touch the dashboard session.
 */
export function OnPageEditor({ canvasId, htmlPath, saving, onSave }: OnPageEditorProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  // Fixed src (no refresh key) so saving never reloads the page mid-edit.
  const src = `/api/canvases/${canvasId}/preview/?edit=1`;

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Validate by source window, not origin. The sandboxed iframe is opaque ("null").
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
    <WorkspacePane className="flex h-full flex-col">
      <PaneHeader
        leading={
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-surface-sunken text-subtle">
            <TextAa size={15} weight="duotone" aria-hidden />
          </span>
        }
        title="Page text"
        description={<span className="font-mono">{htmlPath}</span>}
        actions={
          <span className="text-xs text-subtle">{saving ? "Saving..." : "Click text to edit"}</span>
        }
      />
      <iframe
        key={htmlPath}
        ref={iframeRef}
        title="On-page editor"
        src={src}
        // allow-modals lets the formatting toolbar's link prompt() run; still no
        // allow-same-origin, so the page stays in an opaque origin (can't touch the session).
        sandbox="allow-scripts allow-forms allow-modals"
        className="h-full w-full bg-surface"
      />
    </WorkspacePane>
  );
}
