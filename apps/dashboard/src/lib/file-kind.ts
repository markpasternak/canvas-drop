/**
 * Decide how a draft file opens in the editor. We use an **editable-text allowlist
 * + size cap**, NOT a binary denylist: the server downgrades unknown extensions
 * (e.g. .xlsx) to `text/plain`, so a denylist would let a spreadsheet's bytes load
 * into CodeMirror and hang the tab. Anything not provably small text is treated as
 * a non-editable asset (preview/download/replace only).
 */

import type { DraftFile } from "./api.js";

/** Largest file we'll open in the text editor (bigger text still downloads/replaces). */
export const EDITABLE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

/** Extensions we open in CodeMirror. Allowlist — unknown types are never editable. */
const EDITABLE_EXT = new Set([
  "html",
  "htm",
  "xhtml",
  "css",
  "scss",
  "sass",
  "less",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "json",
  "jsonc",
  "json5",
  "md",
  "markdown",
  "mdx",
  "txt",
  "text",
  "log",
  "svg",
  "xml",
  "rss",
  "atom",
  "webmanifest",
  "map",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "csv",
  "tsv",
  "env",
  "sh",
  "bash",
  "zsh",
  "gitignore",
  "htaccess",
]);

/** Filenames (no extension) we still treat as editable text. */
const EDITABLE_NAMES = new Set([
  "readme",
  "license",
  "licence",
  "changelog",
  "authors",
  "dockerfile",
  "makefile",
  "procfile",
  ".gitignore",
  ".env",
  "llms.txt",
]);

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
}

/**
 * Mirror of the server's `normalizeEntryPath` (deploy/validate.ts), enough to map a
 * user-typed path to the manifest key the server would store — so the Add/Rename
 * dialogs can flag a duplicate path inline before issuing a destructive write. The
 * server stays authoritative (it re-normalizes and rejects PATH_EXISTS); this is
 * just instant feedback. Returns null for paths the server would reject outright
 * (empty, directory, `..`, dotfiles, absolute) — callers treat null as "not a
 * confirmable duplicate" and let the server have the final say.
 */
export function normalizeDraftPath(raw: string): string | null {
  const p = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
  if (p === "" || p.endsWith("/") || p.startsWith("/")) return null;
  for (const seg of p.split("/")) {
    if (seg === ".." || seg.startsWith(".")) return null;
  }
  return p;
}

/** Why a file isn't editable — drives the non-editable view's message. */
export type NonEditableReason = "binary" | "too-large";

/** True when the file should open in the text editor (small + recognized text). */
export function isEditableFile(file: Pick<DraftFile, "path" | "mime" | "size">): boolean {
  if (file.size > EDITABLE_MAX_BYTES) return false;
  const ext = extOf(file.path);
  if (ext) return EDITABLE_EXT.has(ext);
  // No extension: trust a real text/* MIME, or a known texty filename. We do NOT
  // trust a bare `text/plain` on a file WITH an unknown extension (that's the
  // server's downgrade default for binaries), which is why the ext check is first.
  return file.mime.toLowerCase().startsWith("text/") || EDITABLE_NAMES.has(baseName(file.path));
}

/** Reason a file is non-editable (only meaningful when isEditableFile is false). */
export function nonEditableReason(
  file: Pick<DraftFile, "path" | "mime" | "size">,
): NonEditableReason {
  return file.size > EDITABLE_MAX_BYTES ? "too-large" : "binary";
}

/** True for image media that gets an inline preview (SVG is editable text, so excluded). */
export function isImage(file: Pick<DraftFile, "path" | "mime">): boolean {
  if (file.mime.toLowerCase().startsWith("image/") && extOf(file.path) !== "svg") return true;
  const ext = extOf(file.path);
  return IMAGE_EXT.has(ext) && ext !== "svg";
}

/** Short uppercase type label for a file (e.g. "HTML", "XLSX", "FILE"). */
export function fileLabel(file: Pick<DraftFile, "path">): string {
  return extOf(file.path).toUpperCase() || "FILE";
}

/**
 * True for an HTML page the server renders as the canvas entry. Keyed on MIME
 * (`text/html`) — NOT the extension — so the dashboard's on-page availability
 * matches the server's entry resolution exactly (rootEntry/soleHtmlEntry also key
 * on `text/html`). Keeping these in lockstep means on-page mode is never offered
 * for a file the preview can't actually render as the page (e.g. a lone `.xhtml`,
 * which the server downgrades to `text/plain`).
 */
export function isHtmlFile(file: Pick<DraftFile, "mime">): boolean {
  return file.mime.toLowerCase().startsWith("text/html");
}

/**
 * The single HTML page in a draft, or null when there are zero or several. On-page
 * text editing is only offered for a single static HTML page — with 0 or 2+ HTML
 * files there's no unambiguous page to edit, and JS-rendered SPAs keep their text
 * in scripts (not editable on the page). Any number of non-HTML assets is fine —
 * they render around the page; only the HTML count matters.
 */
export function singleHtmlFile<T extends Pick<DraftFile, "mime">>(files: T[]): T | null {
  const html = files.filter(isHtmlFile);
  return html.length === 1 ? (html[0] ?? null) : null;
}
