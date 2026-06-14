import type { Config } from "@canvas-drop/shared";
import type { Canvas, Manifest, ManifestEntry } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { VersionsRepository } from "../db/repositories/versions.js";
import { errorResponse } from "../http/error-pages.js";
import { baseSecurityHeaders } from "../http/security-headers.js";
import type { AppEnv } from "../http/types.js";
import type { StorageDriver } from "../storage/driver.js";
import { assetPathFor, resolveAsset } from "./asset-resolver.js";
import { mimeFor } from "./mime.js";
import { blobKey } from "./storage-keys.js";

/** Filenames that look content-hashed (e.g. app.a1b2c3d4.js) get immutable caching. */
const CONTENT_HASH_RE = /\.[0-9a-f]{8,}\.[a-z0-9]+$/i;

export interface ServeDeps {
  config: Config;
  versions: VersionsRepository;
  storage: StorageDriver;
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

    const bytes = await deps.storage.get(blobKey(canvas.id, entry.hash));
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
  // Shared §12.4 baseline (nosniff, Referrer-Policy, COOP — COOP newly added for
  // canvas content, M7 audit), plus the canvas-content-specific frame-ancestors.
  baseSecurityHeaders(headers);
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
  const copy = NOT_FOUND_COPY[reason];
  return errorResponse(
    c,
    {
      status: 404,
      code: "not_found",
      title: copy.title,
      message: copy.body,
      hint: copy.hint,
    },
    { error: "not_found" },
    {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "frame-ancestors 'none'",
    },
  );
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
