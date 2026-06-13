import { isImageMime } from "../lib/file-kind.js";
import { formatBytes } from "../lib/format.js";

export interface BinaryFileViewProps {
  canvasId: string;
  path: string;
  mime: string;
  size: number;
  /** Bumped after a replace so the image src reloads. */
  refreshKey: number;
}

/**
 * Non-editable draft file (image, font, archive, …). Images get an inline preview
 * from the owner-only raw-file route; everything else gets a typed placeholder. In
 * both cases the file is editable only by **Replace** (upload) from the toolbar —
 * loading binary bytes into the text editor would corrupt them on save.
 */
export function BinaryFileView({ canvasId, path, mime, size, refreshKey }: BinaryFileViewProps) {
  const src = `/api/canvases/${canvasId}/draft/file?path=${encodeURIComponent(path)}&r=${refreshKey}`;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 rounded-md border border-border bg-surface p-6 text-center">
      {isImageMime(mime) ? (
        <img
          src={src}
          alt={path}
          className="max-h-[20rem] max-w-full rounded border border-border object-contain"
        />
      ) : (
        <div className="grid size-16 place-items-center rounded-lg bg-canvas text-2xl" aria-hidden>
          📄
        </div>
      )}
      <div className="space-y-0.5">
        <p className="font-mono text-sm text-fg">{path}</p>
        <p className="text-xs text-subtle">
          {mime} · {formatBytes(size)}
        </p>
        <p className="text-xs text-muted">
          This file can’t be edited as text. Use <span className="font-medium">Replace</span> to
          swap it.
        </p>
      </div>
    </div>
  );
}
