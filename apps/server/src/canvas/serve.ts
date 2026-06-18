import type { Config } from "@canvas-drop/shared";
import type { Canvas, Manifest, ManifestEntry } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { UsageEventsRepository } from "../db/repositories/usage-events.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import { canvasCacheControl, effectiveEdgeTtlSec } from "../http/cdn-cache.js";
import { errorResponse } from "../http/error-pages.js";
import { baseSecurityHeaders } from "../http/security-headers.js";
import type { AppEnv } from "../http/types.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";
import { assetPathFor, resolveAsset } from "./asset-resolver.js";
import { isAnonymouslyPublic, principalAttributionId } from "./authorization.js";
import { mimeFor } from "./mime.js";
import { blobKey } from "./storage-keys.js";

/** Filenames that look content-hashed (e.g. app.a1b2c3d4.js) get immutable caching. */
const CONTENT_HASH_RE = /\.[0-9a-f]{8,}\.[a-z0-9]+$/i;

/** A "view" is one HTML-document load per viewer per this sliding window (D24).
 *  A refresh/return inside the window doesn't re-count; idle past it = a new view. */
const VIEW_SESSION_MS = 30 * 60 * 1000;

export interface ServeDeps {
  config: Config;
  versions: VersionsRepository;
  storage: StorageDriver;
  usage: UsageEventsRepository;
  /** Optional — when present, a swallowed view-metering failure is logged (warn). */
  log?: Logger;
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
    const { contentType } = mimeFor(resolved.path);
    // Only `public_link` with no password gate AND an unexpired share — the single
    // state an anonymous request can reach — may be cached by a shared CDN; every
    // other rung stays `private` (§12.2). The s-maxage is clamped to the share expiry
    // so a CDN can never keep serving a public canvas past the moment it locks down.
    const now = Date.now();
    const anonymouslyPublic = isAnonymouslyPublic(
      canvas.access,
      canvas.passwordHash !== null,
      canvas.sharedExpiresAt,
      now,
    );
    const cacheControl = canvasCacheControl({
      contentHashed: CONTENT_HASH_RE.test(resolved.path),
      anonymouslyPublic,
      edgeTtlSec: effectiveEdgeTtlSec(
        deps.config.serving.publicEdgeCacheTtlSec,
        canvas.sharedExpiresAt,
        now,
      ),
    });

    // Record a view on the initial HTML-document load of a session (D24, §6.9.6).
    // HTML docs only (sub-assets like js/css/img never count); deduped per viewer
    // within VIEW_SESSION_MS; fired off the response path so serving never waits on
    // or fails from metering. Runs before the 304 branch so a returning viewer's
    // revalidation counts (or doesn't) by the same session rule as a full load.
    recordView(c, deps, canvas, contentType);

    // Conditional GET → 304 (revalidation is cheap; the ETag is the content hash).
    // Match weak-ETag-tolerantly: a CDN/proxy in front may downgrade our strong
    // validator to `W/"…"` when it compresses the response, and would then send the
    // weak form back in If-None-Match. A strict `===` would miss it and force a full
    // 200 — the opposite of what a CDN is for. ifNoneMatchHits normalizes both sides.
    if (ifNoneMatchHits(c.req.header("if-none-match"), etag)) {
      const headers = new Headers({ ETag: etag, "Cache-Control": cacheControl });
      securityHeaders(headers);
      return new Response(null, { status: 304, headers });
    }

    const bytes = await deps.storage.get(blobKey(canvas.id, entry.hash));
    if (!bytes) return notFound(c, "missing");

    const headers = new Headers({ ETag: etag, "Cache-Control": cacheControl });
    headers.set("Content-Type", contentType);
    // Cross-canvas XSS guard for path mode (review server-canvas-5): in path mode all
    // canvases share one origin, so an inline-served SVG with embedded <script> would
    // execute in the shared origin and reach other canvases' sessions. Force SVGs to
    // download instead of rendering. Subdomain mode isolates each canvas to its own
    // origin, so the inline SVG can't reach across canvases there — leave it inline.
    if (deps.config.urlMode === "path" && contentType.startsWith("image/svg+xml")) {
      headers.set("Content-Disposition", "attachment");
    }
    securityHeaders(headers);
    // Copy into a fresh Uint8Array so the body is a plain ArrayBuffer view.
    return new Response(new Uint8Array(bytes), { status: 200, headers });
  });
}

/**
 * Fire-and-forget view metering for an HTML-document serve. No-ops for sub-assets
 * (only `text/html` counts as a page view) and when no viewer is in context. The
 * repo dedupes per viewer within the session window; we never await it, and any
 * failure is swallowed so metering can never delay or break serving (mirrors the
 * audit-log / usage-event best-effort contract).
 */
function recordView(
  c: Context<AppEnv>,
  deps: ServeDeps,
  canvas: Canvas,
  contentType: string,
): void {
  if (!contentType.startsWith("text/html")) return;
  // Attribute to the org member, the invited guest, or an anonymous public visitor
  // (U11) — usage_events.userId is plain text, so all principals are counted.
  void deps.usage
    .recordView({
      canvasId: canvas.id,
      userId: principalAttributionId(c),
      windowMs: VIEW_SESSION_MS,
      now: Date.now(),
    })
    // Best-effort: serving never fails on metering, but a persistent write failure
    // (e.g. a schema/table problem in a fresh env) must not be invisible — warn so
    // perpetually-zero view counts have a trail instead of silent swallowing.
    .catch((err) => {
      deps.log?.warn({ err, canvasId: canvas.id }, "view metering failed");
    });
}

/**
 * True when an `If-None-Match` request header validates against our (strong) ETag.
 * Tolerates a weak (`W/"…"`) validator and a comma-separated list, both of which an
 * intermediary CDN may produce, by comparing on the opaque-tag value alone. (We never
 * serve `*`, and a strong/weak distinction is irrelevant for a content-hash ETag, so a
 * value match is a content match.)
 */
function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const want = etagValue(etag);
  return header.split(",").some((candidate) => etagValue(candidate) === want);
}

/** Strip an optional `W/` weakness marker and surrounding whitespace from an ETag. */
function etagValue(raw: string): string {
  return raw.trim().replace(/^W\//, "");
}

function securityHeaders(headers: Headers): void {
  // Shared §12.4 baseline (nosniff, Referrer-Policy, COOP — COOP newly added for
  // canvas content, M7 audit), plus the canvas-content-specific frame-ancestors.
  baseSecurityHeaders(headers);
  // `'self'`, not `'none'`: a canvas may frame *itself* (same origin) so same-origin
  // tools work — e.g. reveal.js speaker notes, which embeds the deck in an iframe. In
  // subdomain mode (the recommended multi-user prod) every canvas is its own origin,
  // so this still blocks framing by any OTHER canvas and by the dashboard — the
  // cross-canvas / canvas→management isolation (§12.2) is unchanged. In path mode
  // canvases share an origin, but that is the documented reduced-isolation mode.
  headers.set("Content-Security-Policy", "frame-ancestors 'self'");
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
