import type { Config } from "@canvas-drop/shared";
import type { Canvas, Manifest, ManifestEntry } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { AppEnv } from "../http/types.js";
import type { StorageDriver } from "../storage/driver.js";
import { rootEntry } from "./manifest.js";
import { mimeFor } from "./mime.js";
import { versionStorageKey } from "./storage-keys.js";

/** Filenames that look content-hashed (e.g. app.a1b2c3d4.js) get immutable caching. */
const CONTENT_HASH_RE = /\.[0-9a-f]{8,}\.[a-z0-9]+$/i;

export interface ServeDeps {
  config: Config;
  versions: VersionsRepository;
  storage: StorageDriver;
}

/** Extract the asset path (after the slug) from the request path. */
export function assetPathFor(config: Config, slug: string, reqPath: string): string {
  let p = reqPath;
  if (config.urlMode === "path") {
    const prefix = `/c/${slug}`;
    p = p.startsWith(prefix) ? p.slice(prefix.length) : p;
  }
  p = p.replace(/^\/+/, ""); // strip leading slash
  return p;
}

/**
 * Resolve a request to a manifest entry path: exact hit → directory index →
 * root entry → SPA fallback → null. Pure so the resolution table is unit-testable.
 *
 * The canvas "root entry" is index.html, or — forgiving a one-file deploy whose
 * page isn't named index.html — the single HTML file ({@link rootEntry}). The
 * root request and the SPA fallback both resolve to that SAME entry, so a
 * single-page app with a non-index entry works at the root AND for deep client
 * routes when SPA fallback is on. With several HTML files and no index, the
 * entry is undefined and both 404 (there's no way to pick the home page).
 */
export function resolveAsset(
  manifest: Manifest,
  assetPath: string,
  spaFallback: boolean,
): { path: string } | null {
  // Exact file hit (non-root).
  if (assetPath !== "" && manifest[assetPath]) return { path: assetPath };
  // Directory request → its own index.html.
  if (assetPath !== "") {
    const dirIndex = `${assetPath.replace(/\/$/, "")}/index.html`;
    if (manifest[dirIndex]) return { path: dirIndex };
  }
  const entry = rootEntry(manifest).path;
  // Root → the entry.
  if (assetPath === "" && entry) return { path: entry };
  // SPA fallback → the entry for any unmatched path (client-side routing).
  if (spaFallback && entry) return { path: entry };
  return null;
}

/**
 * Canvas asset serving (§6.1.4–10, §9.3.4, §13.5, §12.4). Resolves the current
 * version's manifest, streams the file from the StorageDriver, and applies MIME,
 * ETag/cache (KTD-5), and the §12.4 security headers. Runs after canvasAccess
 * (U15) + the password gate (U16); the canvas is already in context.
 */
export function serveCanvas(deps: ServeDeps) {
  return createMiddleware<AppEnv>(async (c) => {
    const canvas = c.get("canvas") as Canvas;
    if (!canvas.currentVersionId) return notFound(c, "unpublished"); // never deployed

    const version = await deps.versions.findById(canvas.currentVersionId);
    if (version?.status !== "ready" || !version.manifest) return notFound(c, "unpublished");
    const manifest = version.manifest as Manifest;

    const assetPath = assetPathFor(deps.config, canvas.slug, c.req.path);
    const resolved = resolveAsset(manifest, assetPath, canvas.spaFallback);
    // A root request that resolves to nothing means there's no home page (no
    // index.html / no single HTML file); a non-root miss is just a missing path.
    if (!resolved) return notFound(c, assetPath === "" ? "no-home" : "missing");

    const entry = manifest[resolved.path] as ManifestEntry;
    const etag = `"${entry.hash}"`;

    // Conditional GET → 304 (revalidation is cheap; the ETag is the content hash).
    if (c.req.header("if-none-match") === etag) {
      const headers = new Headers(cacheHeaders(resolved.path, etag));
      securityHeaders(headers);
      return new Response(null, { status: 304, headers });
    }

    const bytes = await deps.storage.get(versionStorageKey(version.id, resolved.path));
    if (!bytes) return notFound(c, "missing");

    const { contentType } = mimeFor(resolved.path);
    const headers = new Headers(cacheHeaders(resolved.path, etag));
    headers.set("Content-Type", contentType);
    securityHeaders(headers);
    // Copy into a fresh Uint8Array so the body is a plain ArrayBuffer view.
    return new Response(new Uint8Array(bytes), { status: 200, headers });
  });
}

function cacheHeaders(path: string, etag: string): Record<string, string> {
  // Content-hashed filenames are immutable; everything else revalidates (instant
  // redeploys via the pointer swap). The ETag makes revalidation a cheap 304.
  const cacheControl = CONTENT_HASH_RE.test(path)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  return { ETag: etag, "Cache-Control": cacheControl };
}

function securityHeaders(headers: Headers): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
}

type NotFoundReason = "unpublished" | "no-home" | "missing";

/**
 * Canvas-content 404. Content-negotiated: programmatic clients still get the
 * stable `{"error":"not_found"}` JSON, but a browser (Accept: text/html) gets a
 * small, self-contained page explaining what's wrong — so a visitor sees a real
 * page instead of raw JSON. Only reached for an ACCESSIBLE canvas with no
 * content at the path; access-denial 404s come from canvasAccess (no leak).
 */
function notFound(c: Context<AppEnv>, reason: NotFoundReason = "missing") {
  const wantsHtml = c.req.header("accept")?.includes("text/html") ?? false;
  const headers = new Headers({
    "Content-Type": wantsHtml ? "text/html; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
  });
  securityHeaders(headers);
  const body = wantsHtml ? notFoundPage(reason) : JSON.stringify({ error: "not_found" });
  return c.body(body, 404, Object.fromEntries(headers));
}

const NOT_FOUND_COPY: Record<NotFoundReason, { title: string; body: string; hint?: string }> = {
  unpublished: {
    title: "Not published yet",
    body: "This canvas doesn’t have a published version to show.",
  },
  "no-home": {
    title: "No home page",
    body: "This canvas was published without an index.html, so there’s nothing to show at its root.",
    hint: "Deploy a file named index.html to set the home page.",
  },
  missing: {
    title: "Page not found",
    body: "There’s no page at this address.",
  },
};

/** A tiny, dependency-free, org-agnostic 404 page (light + dark). Copy is static
 *  — no canvas data is interpolated, so there's nothing to escape or leak. */
function notFoundPage(reason: NotFoundReason): string {
  const { title, body, hint } = NOT_FOUND_COPY[reason];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 2rem;
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #fbfbfc; color: #1a1a1e; }
  main { max-width: 26rem; text-align: center; }
  .code { margin: 0; font: 600 .75rem ui-monospace, monospace; letter-spacing: .08em; color: #8a8a93; }
  h1 { margin: .5rem 0; font-size: 1.375rem; letter-spacing: -.01em; }
  p.msg { margin: 0; color: #56565f; }
  .hint { margin-top: 1.25rem; padding: .5rem .75rem; display: inline-block; border-radius: .5rem;
    font: .8125rem ui-monospace, monospace; color: #56565f; background: rgba(0,0,0,.04); }
  @media (prefers-color-scheme: dark) {
    body { background: #0a0a0c; color: #f4f4f5; }
    p.msg, .code, .hint { color: #a1a1aa; } .hint { background: rgba(255,255,255,.06); }
  }
</style>
</head>
<body>
  <main>
    <p class="code">404</p>
    <h1>${title}</h1>
    <p class="msg">${body}</p>
    ${hint ? `<p class="hint">${hint}</p>` : ""}
  </main>
</body>
</html>`;
}
