import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type VersionInfo } from "../lib/api.js";
import { archiveText, compareArchives, readCanvasArchive } from "../lib/canvas-archive.js";
import { formatBytes } from "../lib/format.js";
import { Button } from "./Button.js";
import { CodeEditor } from "./CodeEditor.js";
import { ReadError } from "./ReadError.js";

/** Protected exports only. Inspection never restores a version or moves either pointer. */
export function VersionInspection({
  canvasId,
  version,
  current,
  onClose,
}: {
  canvasId: string;
  version: VersionInfo;
  current?: VersionInfo;
  onClose: () => void;
}) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    section.current?.focus();
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  const [path, setPath] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const old = useQuery({
    queryKey: ["version-inspection", canvasId, version.number],
    queryFn: async ({ signal }) =>
      readCanvasArchive(await api.downloadVersion(canvasId, version.number, signal)),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const live = useQuery({
    queryKey: ["version-inspection", canvasId, current?.number],
    queryFn: async ({ signal }) =>
      readCanvasArchive(await api.downloadVersion(canvasId, current?.number as number, signal)),
    enabled: compare && !!current && current.number !== version.number,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const changes = useMemo(
    () => (old.data && live.data ? compareArchives(old.data, live.data) : []),
    [old.data, live.data],
  );
  const selected = path ?? version.entry?.path ?? old.data?.[0]?.path;
  const file = old.data?.find((file) => file.path === selected);
  const currentFile = live.data?.find((file) => file.path === selected);
  const source = archiveText(file);
  const currentSource = archiveText(currentFile);
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label={`Inspect version ${version.number}`}
      className="min-w-0 space-y-4 border-y border-border py-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-h2 text-fg">Inspect v{version.number}</h2>
          <p className="mt-1 text-sm text-muted">
            Read-only source. Your working draft and current version stay unchanged.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close inspection
        </Button>
      </div>
      {old.isPending && (
        <p role="status" className="text-sm text-muted">
          Loading protected version files…
        </p>
      )}
      {old.isError && (
        <ReadError title="Couldn't inspect this version" onRetry={() => void old.refetch()}>
          {old.error.message} You can also download the ZIP.
        </ReadError>
      )}
      {old.data && (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <label className="min-w-0 flex-1 space-y-1 text-sm">
              <span className="block text-muted">File in this version</span>
              <select
                aria-label="Version file"
                value={selected ?? ""}
                onChange={(event) => setPath(event.target.value)}
                className="min-h-11 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-fg"
              >
                {(compare && live.data ? changes : old.data).map((file) => (
                  <option key={file.path} value={file.path}>
                    {file.path}
                    {"kind" in file ? ` · ${file.kind}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {current && current.number !== version.number && (
              <Button
                variant="secondary"
                onClick={() => setCompare((value) => !value)}
                aria-pressed={compare}
              >
                {compare ? "Hide comparison" : `Compare with current v${current.number}`}
              </Button>
            )}
          </div>
          {compare && live.isPending && (
            <p role="status" className="text-sm text-muted">
              Loading current version for comparison…
            </p>
          )}
          {compare && live.isError && (
            <ReadError
              title="Couldn't load the current version"
              onRetry={() => void live.refetch()}
            >
              {live.error.message}
            </ReadError>
          )}
          {compare && live.data && (
            <p role="status" className="text-sm text-muted">
              From v{version.number} to current v{current?.number}:{" "}
              {changes.filter((file) => file.kind === "added").length} added,{" "}
              {changes.filter((file) => file.kind === "changed").length} changed,{" "}
              {changes.filter((file) => file.kind === "removed").length} removed,{" "}
              {changes.filter((file) => file.kind === "unchanged").length} unchanged.
            </p>
          )}
          <div className={`grid min-w-0 gap-4 ${compare && live.data ? "xl:grid-cols-2" : ""}`}>
            <div className="min-w-0">
              <h3 className="mb-2 text-sm font-medium">
                v{version.number} · {file ? formatBytes(file.bytes.length) : "File absent"}
              </h3>
              <div className="h-80 min-w-0 overflow-hidden rounded-lg border border-border">
                {source !== null && selected ? (
                  <CodeEditor
                    key={`${version.number}:${selected}`}
                    label={`Version ${version.number} source for ${selected}`}
                    path={selected}
                    value={source}
                    readOnly
                    onChange={() => {}}
                  />
                ) : (
                  <p className="p-4 text-sm text-muted">
                    {file
                      ? "Binary, non-UTF-8 or large source file. Download the ZIP to inspect it locally; text inspection is limited to 512 KB per file."
                      : "This file is not in this version."}
                  </p>
                )}
              </div>
            </div>
            {compare && live.data && (
              <div className="min-w-0">
                <h3 className="mb-2 text-sm font-medium">
                  Current v{current?.number} ·{" "}
                  {currentFile ? formatBytes(currentFile.bytes.length) : "File absent"}
                </h3>
                <div className="h-80 min-w-0 overflow-hidden rounded-lg border border-border">
                  {currentSource !== null && selected ? (
                    <CodeEditor
                      key={`current:${current?.number}:${selected}`}
                      label={`Current version ${current?.number} source for ${selected}`}
                      path={selected}
                      value={currentSource}
                      readOnly
                      onChange={() => {}}
                    />
                  ) : (
                    <p className="p-4 text-sm text-muted">
                      {currentFile
                        ? "Download the ZIP to inspect this binary or large file locally."
                        : "This file is not in the current version."}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
