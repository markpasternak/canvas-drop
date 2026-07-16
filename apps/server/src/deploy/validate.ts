import { DeployError } from "./errors.js";

/**
 * Normalize and validate a deploy entry path. Rejects path traversal / absolute
 * paths (zip-slip, §12.1.5) and signals dotfiles for stripping (§6.1.19).
 * Returns the cleaned forward-slash path, or `null` when the entry should be
 * dropped (dotfile / empty / directory marker).
 */
export function normalizeEntryPath(raw: string): string | null {
  // Normalize separators and strip a leading "./" or "/".
  let p = raw.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (p === "" || p.endsWith("/")) return null; // empty or directory marker

  // Interior "." segments are no-op path components (`a/./b` = `a/b`), not
  // dotfiles — drop the segment, don't drop the file.
  const segments = p.split("/").filter((seg) => seg !== ".");
  if (segments.length === 0 || segments[segments.length - 1] === "") return null;
  for (const seg of segments) {
    if (seg === "..") {
      throw new DeployError("ZIP_SLIP_REJECTED", `path escapes the canvas root: ${raw}`, raw);
    }
    // dotfiles / dotdirs (e.g. .git, .env) are stripped from the deploy
    if (seg.startsWith(".")) return null;
  }
  if (p.startsWith("/")) {
    throw new DeployError("INVALID_PATH", `absolute path not allowed: ${raw}`, raw);
  }
  p = segments.join("/");
  return p;
}
