import { DownloadSimple, UploadSimple } from "@phosphor-icons/react";
import type { DraftFile } from "../lib/api.js";
import { fileLabel, isImage, type NonEditableReason } from "../lib/file-kind.js";
import { formatBytes } from "../lib/format.js";
import { Button } from "./Button.js";
import { FileKindIcon } from "./FileTree.js";

export interface NonEditableFileViewProps {
  canvasId: string;
  file: DraftFile;
  reason: NonEditableReason;
  /** Bumped after a replace so the image src reloads. */
  refreshKey: number;
  onReplace: () => void;
}

/**
 * A draft file that can't be edited as text (binary media, or text too large for
 * the editor). Images get an inline preview; everything else a typed file card with
 * a clear "can't edit" message and the two actions you actually want here: Download
 * and Replace. Structure adapted from the file-detail mockup.
 */
export function NonEditableFileView({
  canvasId,
  file,
  reason,
  refreshKey,
  onReplace,
}: NonEditableFileViewProps) {
  const src = `/api/canvases/${canvasId}/draft/file?path=${encodeURIComponent(file.path)}&r=${refreshKey}`;
  const downloadName = file.path.slice(file.path.lastIndexOf("/") + 1);
  const heading = reason === "too-large" ? "Too large to edit here" : "Can’t edit this file type";
  const description =
    reason === "too-large"
      ? `${fileLabel(file)} files over 2 MB aren’t edited in the browser. Download it, or replace it with a new version.`
      : `${fileLabel(file)} files can’t be edited as text. Download it to view, or replace it with a new version.`;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-surface p-6 text-center">
      {isImage(file) ? (
        <img
          src={src}
          alt={file.path}
          className="max-h-[18rem] max-w-full rounded-lg border border-border bg-surface-sunken object-contain"
        />
      ) : (
        <>
          <div className="rounded-xl border border-border bg-surface-sunken p-4">
            <FileKindIcon file={file} size={34} />
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-fg">{heading}</h3>
            <p className="mx-auto max-w-sm text-sm text-muted">{description}</p>
          </div>
        </>
      )}

      <div className="w-full max-w-sm space-y-3 border-t border-border pt-4">
        <div className="space-y-0.5">
          <p className="break-all font-mono text-xs text-fg">{file.path}</p>
          <p className="text-xs text-subtle">
            {fileLabel(file)}
            <span className="mx-2 text-border-strong" aria-hidden>
              /
            </span>
            {formatBytes(file.size)}
          </p>
        </div>
        <div className="flex justify-center gap-2">
          <a
            href={src}
            download={downloadName}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg shadow-[var(--shadow-panel)] transition-colors hover:bg-accent-hover"
          >
            <DownloadSimple size={16} weight="bold" aria-hidden />
            Download file
          </a>
          <Button variant="secondary" onClick={onReplace}>
            <UploadSimple size={16} weight="bold" aria-hidden />
            Replace file
          </Button>
        </div>
      </div>
    </div>
  );
}
