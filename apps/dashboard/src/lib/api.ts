/**
 * Typed client for the session-authenticated management API (§11.3). Same-origin,
 * cookie-credentialed. Two cross-cutting behaviours live here so no caller
 * re-derives them:
 *   1. Auth-expiry contract (KTD-8): a 401, or a response redirected to the login
 *      page / returning HTML instead of JSON, means the session expired — we do a
 *      full-page navigation to login rather than surfacing an in-SPA error.
 *   2. Stable error codes → a typed ApiError carrying a human/agent `hint`.
 */

export interface Me {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
}

export interface Canvas {
  id: string;
  slug: string;
  url: string;
  title: string;
  description: string | null;
  shared: boolean;
  sharedExpiresAt: number | null;
  hasPassword: boolean;
  spaFallback: boolean;
  galleryListed: boolean;
  gallerySummary: string | null;
  galleryTags: string[] | null;
  status: string;
  currentVersionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LastDeploy {
  version: number;
  createdAt: number;
  fileCount: number;
  totalBytes: number;
}

export type CanvasListItem = Canvas & { lastDeploy: LastDeploy | null };

export interface VersionInfo {
  number: number;
  source: string;
  status: string;
  createdBy: string;
  createdAt: number;
  fileCount: number;
  totalBytes: number;
  current: boolean;
}

export interface DeployResult {
  url: string;
  version: number;
  fileCount: number;
  totalBytes: number;
  warnings?: string[];
}

export interface CanvasSettings {
  title?: string;
  description?: string | null;
  shared?: boolean;
  sharedExpiresAt?: number | null;
  password?: string | null;
  spaFallback?: boolean;
  galleryListed?: boolean;
  gallerySummary?: string | null;
  galleryTags?: string[];
}

/** Human/agent-readable hints for the stable deploy + management error codes. */
const HINTS: Record<string, string> = {
  EMPTY_DEPLOY: "The upload was empty — add at least an index.html.",
  TOO_MANY_FILES: "Too many files — a canvas allows up to 2,000.",
  FILE_TOO_LARGE: "A file exceeds the 25 MB per-file limit.",
  CANVAS_TOO_LARGE: "The canvas exceeds the 100 MB total limit.",
  ZIP_SLIP_REJECTED: "The ZIP contained an unsafe path (`..` or absolute).",
  ZIP_BOMB_REJECTED: "The ZIP's declared size is implausibly large.",
  INVALID_ZIP: "The file isn't a valid ZIP archive.",
  INVALID_PATH: "A path or version was invalid.",
  VERSION_UNAVAILABLE: "That version was just removed — refresh and pick another.",
  invalid_body: "Some fields were invalid — check and try again.",
  not_found: "Not found.",
  cross_origin_forbidden: "Request blocked — reload the page and retry.",
};

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly path?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get hint(): string {
    return HINTS[this.code] ?? this.message;
  }
}

/** Redirect the whole page to login. Idempotent + overridable in tests. */
let redirecting = false;
let onAuthExpired = () => {
  if (redirecting) return;
  redirecting = true;
  window.location.assign("/auth/login");
};
export function setAuthExpiredHandler(fn: () => void) {
  onAuthExpired = fn;
  redirecting = false;
}

function isJson(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("application/json");
}

/**
 * The session expired (KTD-8) when: status is 401; the request followed a
 * redirect (a 302 to the OIDC login); OR a 2xx returned a non-JSON body (a proxy
 * served its HTML login page with a 200). A non-2xx non-JSON body (e.g. a 5xx
 * HTML error page) is NOT auth-expiry — it falls through to a normal ApiError.
 */
function isAuthExpiry(res: Response): boolean {
  return res.status === 401 || res.redirected || (res.ok && !isJson(res));
}

/** Map a (possibly JSON) error body to a typed ApiError. Shared by the fetch and
 * XHR paths so the stable-code → hint contract is identical for both. */
function errorFromBody(status: number, statusText: string, text: string): ApiError {
  let code = `http_${status}`;
  let message = statusText || "Request failed";
  let path: string | undefined;
  try {
    const body = JSON.parse(text) as {
      code?: string;
      error?: string;
      message?: string;
      path?: string;
    };
    code = body.code ?? body.error ?? code;
    message = body.message ?? message;
    path = body.path;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(code, message, path, status);
}

async function parseError(res: Response): Promise<ApiError> {
  return errorFromBody(res.status, res.statusText, await res.text().catch(() => ""));
}

/**
 * Upload via XMLHttpRequest so the deploy can report byte-level UPLOAD progress
 * (`fetch` has no upload-progress API). `onProgress` reports the fraction sent
 * (0–1); the server's extract/publish phase isn't streamed, so the caller shows
 * an indeterminate state once it reaches 1. Mirrors `request`'s auth-expiry +
 * stable-error-code handling.
 */
function xhrUpload<T>(
  method: string,
  path: string,
  body: XMLHttpRequestBodyInit,
  onProgress?: (fraction: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.upload.onload = () => onProgress(1); // bytes sent; server now processing
    }
    xhr.onload = () => {
      if (xhr.status === 401) {
        onAuthExpired();
        reject(new ApiError("unauthorized", "Session expired", undefined, 401));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (xhr.status === 204 || !xhr.responseText) return resolve(undefined as T);
        try {
          return resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          return resolve(undefined as T);
        }
      }
      reject(errorFromBody(xhr.status, xhr.statusText, xhr.responseText));
    };
    xhr.onerror = () => reject(new ApiError("network_error", "Network error"));
    xhr.send(body);
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "include",
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiError("network_error", err instanceof Error ? err.message : "Network error");
  }

  if (isAuthExpiry(res)) {
    onAuthExpired();
    throw new ApiError("unauthorized", "Session expired", undefined, res.status);
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function jsonBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const api = {
  me: () => request<Me>("/api/me"),

  listCanvases: () =>
    request<{ canvases: CanvasListItem[] }>("/api/canvases").then((r) => r.canvases),

  getCanvas: (id: string) => request<Canvas>(`/api/canvases/${id}`),

  createCanvas: (body: { title?: string; description?: string }) =>
    request<Canvas & { apiKey: string }>("/api/canvases", jsonBody(body)),

  pasteHtml: (body: { html: string; title?: string }) =>
    request<Canvas & { apiKey: string; deploy: DeployResult }>(
      "/api/canvases/paste",
      jsonBody(body),
    ),

  deployZip: (id: string, zip: ArrayBuffer, onProgress?: (fraction: number) => void) =>
    xhrUpload<DeployResult>("POST", `/api/canvases/${id}/deploy/zip`, zip, onProgress),

  deployFolder: (id: string, form: FormData, onProgress?: (fraction: number) => void) =>
    xhrUpload<DeployResult>("POST", `/api/canvases/${id}/deploy/folder`, form, onProgress),

  updateSettings: (id: string, patch: CanvasSettings) =>
    request<Canvas>(`/api/canvases/${id}/settings`, { ...jsonBody(patch), method: "PATCH" }),

  regenerateSlug: (id: string) =>
    request<Canvas>(`/api/canvases/${id}/regenerate-slug`, { method: "POST" }),

  regenerateKey: (id: string) =>
    request<{ apiKey: string }>(`/api/canvases/${id}/regenerate-key`, { method: "POST" }),

  deleteCanvas: (id: string) => request<{ ok: true }>(`/api/canvases/${id}`, { method: "DELETE" }),

  listVersions: (id: string) =>
    request<{ versions: VersionInfo[] }>(`/api/canvases/${id}/versions`).then((r) => r.versions),

  rollback: (id: string, version: number) =>
    request<Canvas & { version: number }>(`/api/canvases/${id}/rollback`, jsonBody({ version })),
};
