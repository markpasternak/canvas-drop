import type { Config } from "@canvas-drop/shared";

/**
 * URL-mode routing (BUILD_BRIEF.md D2, §8.2, §9.1). A single function classifies
 * every request into a role (and canvas slug when applicable) so no other module
 * branches on URL mode. Pure — no I/O, no DB. Slug→canvas resolution happens
 * later in the request pipeline; this only classifies and extracts the slug.
 */
export type RequestRole = "dashboard" | "auth" | "platform-api" | "canvas";

export interface ResolvedRequest {
  role: RequestRole;
  canvasSlug?: string;
}

export interface RequestParts {
  /** The Host header value (may include a port). */
  host: string;
  /** The URL pathname (e.g. `/v1/c/abc/kv/x`). */
  pathname: string;
}

const PLATFORM_API_RE = /^\/v1\/c\/([^/]+)/;
const CANVAS_PATH_RE = /^\/c\/([^/]+)/;

export function resolveRequest(req: RequestParts, config: Config): ResolvedRequest {
  const host = stripPort(req.host).toLowerCase();
  const path = req.pathname;

  if (config.urlMode === "subdomain") {
    const baseHost = new URL(config.baseUrl).hostname.toLowerCase();
    if (host !== baseHost) {
      // A `{slug}.{baseHost}` request serves canvas content. A single label only
      // (multi-level or unrelated hosts fall through to the safe dashboard default).
      if (host.endsWith(`.${baseHost}`)) {
        const slug = host.slice(0, host.length - baseHost.length - 1);
        if (slug.length > 0 && !slug.includes(".")) {
          return { role: "canvas", canvasSlug: slug };
        }
      }
      return { role: "dashboard" };
    }
    // Base host: dashboard, auth, and the canvas-facing platform API all live here.
    return routeByPath(path);
  }

  // Path mode: one host. `/c/{slug}/...` is canvas content.
  const canvasSlug = match(CANVAS_PATH_RE, path);
  if (canvasSlug) return { role: "canvas", canvasSlug };
  return routeByPath(path);
}

/** Route by path prefix (shared by both modes for the non-canvas-content host). */
function routeByPath(path: string): ResolvedRequest {
  const platformSlug = match(PLATFORM_API_RE, path);
  if (platformSlug) return { role: "platform-api", canvasSlug: platformSlug };
  if (path === "/auth" || path.startsWith("/auth/")) return { role: "auth" };
  // `/api/...` (management) and everything else fall to the dashboard SPA.
  return { role: "dashboard" };
}

function match(re: RegExp, path: string): string | undefined {
  const m = re.exec(path);
  return m?.[1];
}

function stripPort(host: string): string {
  const colon = host.lastIndexOf(":");
  // Leave IPv6 bracketed hosts alone; only strip a trailing :port.
  return colon > -1 && !host.includes("]") ? host.slice(0, colon) : host;
}
