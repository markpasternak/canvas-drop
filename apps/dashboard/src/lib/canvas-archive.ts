import { unzipSync } from "fflate";
import { isEditableFile } from "./file-kind.js";

export interface ArchiveFile {
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
}

// Historical source inspection has tighter browser bounds than canvas uploads.
// Historical content is never executed by this helper.
export const ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;
export const ARCHIVE_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ARCHIVE_MAX_FILES = 1000;

// Browser-safe mirror of server/deploy/errors.ts LIMITS. The parity regression
// imports the authoritative values only in tests, keeping server code out of the bundle.
export const UPLOAD_ARCHIVE_LIMITS = {
  maxCanvasBytes: 100 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  maxFiles: 2000,
} as const;
// Match deploy-common.ts framing allowance; expanded usable content stays <=100 MiB.
export const UPLOAD_ARCHIVE_MAX_BYTES = UPLOAD_ARCHIVE_LIMITS.maxCanvasBytes + 10 * 1024 * 1024;

interface ArchiveBounds {
  maxCanvasBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  maxArchiveBytes: number;
  purpose: "review" | "upload";
}

export function archivePath(raw: string): string | null {
  const path = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (path.startsWith("/") || /^[a-z]:/i.test(path) || path.includes("\0")) {
    throw new Error("A file has an absolute or invalid path. Choose canvas-relative paths.");
  }
  const parts = path.split("/").filter((part) => part !== ".");
  if (parts.some((part) => part === "..")) throw new Error("A file path leaves the canvas folder.");
  if (parts.some((part) => part.startsWith(".")) || path.endsWith("/")) return null;
  if (parts.some((part) => !part) || path === "__proto__") {
    throw new Error("A file has an invalid path.");
  }
  return parts.join("/");
}

/** Read protected historical exports under conservative source-inspection bounds. */
export function readCanvasArchive(data: Uint8Array): ArchiveFile[] {
  return readArchive(data, {
    maxCanvasBytes: ARCHIVE_MAX_BYTES,
    maxFileBytes: ARCHIVE_MAX_FILE_BYTES,
    maxFiles: ARCHIVE_MAX_FILES,
    maxArchiveBytes: ARCHIVE_MAX_BYTES,
    purpose: "review",
  });
}

/** Imports accept the same usable file/count/expanded-byte limits as draft/deploy. */
export function readUploadArchive(data: Uint8Array): ArchiveFile[] {
  return readArchive(data, {
    ...UPLOAD_ARCHIVE_LIMITS,
    maxArchiveBytes: UPLOAD_ARCHIVE_MAX_BYTES,
    purpose: "upload",
  });
}

/** Check usable paths and declared sizes BEFORE allocating inflated file buffers. */
function readArchive(data: Uint8Array, bounds: ArchiveBounds): ArchiveFile[] {
  if (data.byteLength > bounds.maxArchiveBytes)
    throw new Error(
      `Browser ZIP ${bounds.purpose} is limited to ${bounds.maxArchiveBytes / (1024 * 1024)} MB.`,
    );
  const entries = new Map<string, string>();
  const paths = new Set<string>();
  let total = 0;
  let count = 0;
  try {
    unzipSync(data, {
      filter: (file) => {
        const path = archivePath(file.name);
        if (path === null) return false;
        count++;
        if (count > bounds.maxFiles)
          throw new Error(
            `Browser ZIP ${bounds.purpose} is limited to ${bounds.maxFiles.toLocaleString("en-US")} files.`,
          );
        total += file.originalSize;
        if (file.originalSize > bounds.maxFileBytes || total > bounds.maxCanvasBytes) {
          throw new Error(
            `This ZIP exceeds ${bounds.purpose} limits: ${bounds.maxFileBytes / (1024 * 1024)} MB per file and ${bounds.maxCanvasBytes / (1024 * 1024)} MB total.`,
          );
        }
        if (paths.has(path)) throw new Error("Two archive files have the same canvas path.");
        paths.add(path);
        entries.set(file.name, path);
        return false;
      },
    });
    const files = unzipSync(data, { filter: (file) => entries.has(file.name) });
    const result = [...entries].map(([name, path]) => {
      const bytes = files[name];
      if (!Object.hasOwn(files, name) || !bytes)
        throw new Error("An archive file could not be read.");
      return { path, bytes: new Uint8Array(bytes) };
    });
    if (!result.length) throw new Error("This ZIP contains no usable canvas files.");
    return result.sort((a, b) => a.path.localeCompare(b.path));
  } catch (error) {
    if (error instanceof Error && !("code" in error)) throw error;
    throw new Error("This ZIP could not be read. Choose a valid ZIP containing static files.");
  }
}

/** Source inspection is bounded small UTF-8 text, never HTML rendering or script execution. */
export function archiveText(file: ArchiveFile | undefined): string | null {
  if (!file || file.bytes.length > 512 * 1024) return null;
  if (
    !isEditableFile({ path: file.path, size: file.bytes.length, mime: "application/octet-stream" })
  )
    return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    return null;
  }
}

export function compareArchives(before: ArchiveFile[], after: ArchiveFile[]) {
  const a = new Map(before.map((file) => [file.path, file.bytes]));
  const b = new Map(after.map((file) => [file.path, file.bytes]));
  return [...new Set([...a.keys(), ...b.keys()])].sort().map((path) => {
    const old = a.get(path);
    const next = b.get(path);
    const kind = !old
      ? "added"
      : !next
        ? "removed"
        : old.length === next.length && old.every((byte, i) => byte === next[i])
          ? "unchanged"
          : "changed";
    return { path, kind };
  });
}
