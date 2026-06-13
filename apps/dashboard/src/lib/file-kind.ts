/**
 * Classify a draft file by its MIME so the editor knows whether to open it in the
 * text editor or show a non-editable preview. The server already resolves a MIME
 * per file (it downgrades unknown/blocked types to text/plain), so unknown
 * extensions are treated as text — only genuinely binary media is non-editable.
 */

const BINARY_PREFIXES = ["image/", "audio/", "video/", "font/"];
const BINARY_EXACT = new Set([
  "application/octet-stream",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/wasm",
  "application/x-font-ttf",
  "application/vnd.ms-fontobject",
]);

/** True when the file is binary media that can't be meaningfully edited as text. */
export function isBinaryMime(mime: string): boolean {
  const m = mime.toLowerCase();
  if (BINARY_PREFIXES.some((p) => m.startsWith(p))) return true;
  // Strip any `; charset=...` parameter before the exact-match check.
  return BINARY_EXACT.has(m.split(";")[0]?.trim() ?? m);
}

/** True for image media, which gets an inline preview rather than a placeholder. */
export function isImageMime(mime: string): boolean {
  return mime.toLowerCase().startsWith("image/");
}
