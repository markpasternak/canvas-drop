import type { ChangeEvent, ReactNode } from "react";
import { useCallback, useRef } from "react";
import { useDropzone } from "react-dropzone";
import { cn } from "../lib/cn.js";

/** Canvas-relative path for an uploaded file. react-dropzone's file-selector adds
 * `path` for both dragged folders and the directory picker (the directory picker
 * also sets webkitRelativePath). Strip a leading slash and the top folder segment
 * so a dropped/selected folder deploys its contents at the canvas root. */
export function canvasRelativePath(file: File): string {
  const withPath = file as File & { path?: string };
  const raw = (withPath.path || file.webkitRelativePath || file.name).replace(/^\/+/, "");
  return raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw;
}

export function folderFormFromFiles(files: File[]): FormData {
  const form = new FormData();
  for (const file of files) form.set(canvasRelativePath(file), file);
  return form;
}

/** A click-affordance styled as an inline accent link. */
function PickLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded font-medium text-accent transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {children}
    </button>
  );
}

/** Drag-or-pick upload zone for a folder (files + directory picker) or a single
 * .zip. Shared by the create flow and the redeploy dialog. */
export function FileDrop({
  label,
  variant,
  busy,
  onFiles,
}: {
  label: string;
  variant: "folder" | "zip";
  busy: boolean;
  onFiles: (files: File[]) => void;
}) {
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  // Drag accepts files AND folders together; react-dropzone's file-selector does
  // the cross-browser directory traversal. The native CLICK picker can't offer
  // both at once (OS limit), so we expose two explicit choices instead, hence
  // `noClick` on the zone.
  const onDrop = useCallback(
    (accepted: File[]) => {
      if (accepted.length > 0) onFiles(accepted);
    },
    [onFiles],
  );
  const { getRootProps, isDragActive } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
    disabled: busy,
  });

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = ""; // allow re-selecting the same path
    if (files.length > 0) onFiles(files);
  };

  return (
    <div
      {...getRootProps()}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center transition-colors duration-100 [transition-timing-function:var(--ease-out)]",
        isDragActive
          ? "border-accent bg-accent-subtle/40"
          : "border-border-strong bg-surface-sunken",
        busy && "pointer-events-none opacity-60",
      )}
    >
      <span className="text-sm font-medium text-fg">
        {busy ? "Deploying..." : isDragActive ? "Drop to upload" : label}
      </span>
      {!busy && (
        <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted">
          {variant === "folder" ? (
            <>
              <PickLink onClick={() => filesRef.current?.click()}>Choose files</PickLink>
              <span>or</span>
              <PickLink onClick={() => folderRef.current?.click()}>choose a folder</PickLink>
            </>
          ) : (
            <PickLink onClick={() => filesRef.current?.click()}>Choose a .zip file</PickLink>
          )}
        </div>
      )}
      {/* Files picker (and the zip picker, restricted to .zip). */}
      <input
        ref={filesRef}
        type="file"
        className="hidden"
        multiple={variant === "folder"}
        accept={variant === "zip" ? ".zip" : undefined}
        onChange={pick}
      />
      {/* Folder picker (directory mode) — folder variant only. */}
      {variant === "folder" && (
        <input
          ref={folderRef}
          type="file"
          className="hidden"
          multiple
          {...{ webkitdirectory: "" }}
          onChange={pick}
        />
      )}
    </div>
  );
}

/** The upload step's two faces: the drop zone, or — once a deploy is underway —
 * the progress bar. Both the create flow and the redeploy dialog use this, so
 * the busy↔idle swap lives in one place. */
export function FileDropOrProgress({
  busy,
  pct,
  variant,
  label,
  onFiles,
}: {
  busy: boolean;
  pct: number | null;
  variant: "folder" | "zip";
  label: string;
  onFiles: (files: File[]) => void;
}) {
  return busy ? (
    <DeployProgress pct={pct} />
  ) : (
    <FileDrop label={label} variant={variant} busy={busy} onFiles={onFiles} />
  );
}

/** Deploy progress: a real upload bar (0–100% of bytes sent), then an
 * indeterminate "finishing" pulse while the server extracts/publishes. */
export function DeployProgress({ pct }: { pct: number | null }) {
  const uploading = pct !== null && pct < 100;
  return (
    <div className="space-y-3 py-3" aria-live="polite">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-fg">
          {uploading ? "Uploading files..." : "Finishing deploy..."}
        </span>
        {uploading && <span className="font-mono text-xs text-muted">{pct}%</span>}
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-valuenow={uploading ? (pct ?? 0) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn(
            "h-full rounded-full bg-accent transition-[width] duration-150 [transition-timing-function:var(--ease-out)]",
            !uploading && "w-full animate-pulse",
          )}
          style={uploading ? { width: `${pct ?? 0}%` } : undefined}
        />
      </div>
      <p className="text-xs text-muted">
        {uploading
          ? "Sending your files to the server."
          : "Extracting and publishing your canvas. Almost there."}
      </p>
    </div>
  );
}
