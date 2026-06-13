import type { Config } from "@canvas-drop/shared";
import type { Canvas, Manifest, ManifestEntry } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { AppEnv } from "../http/types.js";
import type { StorageDriver } from "../storage/driver.js";
import { soleHtmlEntry } from "./manifest.js";
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
 * Resolve a request to a manifest entry path: exact hit → directory/root index →
 * SPA fallback → null. Pure so the resolution table is unit-testable.
 */
export function resolveAsset(
  manifest: Manifest,
  assetPath: string,
  spaFallback: boolean,
): { path: string } | null {
  if (assetPath !== "" && manifest[assetPath]) return { path: assetPath };
  // directory or root → index.html
  const indexCandidate =
    assetPath === "" ? "index.html" : `${assetPath.replace(/\/$/, "")}/index.html`;
  if (manifest[indexCandidate]) return { path: indexCandidate };
  // Root with no index.html but a single HTML file → serve it. Forgives a
  // one-file deploy whose page isn't named index.html (e.g. a saved web page),
  // which would otherwise 404 at the root.
  if (assetPath === "") {
    const sole = soleHtmlEntry(manifest);
    if (sole) return { path: sole };
  }
  // SPA fallback → root index.html
  if (spaFallback && manifest["index.html"]) return { path: "index.html" };
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
    if (!canvas.currentVersionId) return notFound(c); // never deployed

    const version = await deps.versions.findById(canvas.currentVersionId);
    if (version?.status !== "ready" || !version.manifest) return notFound(c);
    const manifest = version.manifest as Manifest;

    const assetPath = assetPathFor(deps.config, canvas.slug, c.req.path);
    const resolved = resolveAsset(manifest, assetPath, canvas.spaFallback);
    if (!resolved) return notFound(c);

    const entry = manifest[resolved.path] as ManifestEntry;
    const etag = `"${entry.hash}"`;

    // Conditional GET → 304 (revalidation is cheap; the ETag is the content hash).
    if (c.req.header("if-none-match") === etag) {
      const headers = new Headers(cacheHeaders(resolved.path, etag));
      securityHeaders(headers);
      return new Response(null, { status: 304, headers });
    }

    const bytes = await deps.storage.get(versionStorageKey(version.id, resolved.path));
    if (!bytes) return notFound(c);

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

function notFound(c: Context<AppEnv>) {
  return c.json({ error: "not_found" }, 404);
}
