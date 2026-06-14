/**
 * Typed client for the session-authenticated management API (§11.3). Same-origin,
 * cookie-credentialed. Two cross-cutting behaviours live here so no caller
 * re-derives them:
 *   1. Auth-expiry contract (KTD-8): a 401, or a response redirected to the login
 *      page / returning HTML instead of JSON, means the session expired — we do a
 *      full-page navigation to login rather than surfacing an in-SPA error.
 *   2. Stable error codes → a typed ApiError carrying a human/agent `hint`.
 */

/** Auth mode the instance runs in. `oidc`/`dev` own a revocable session, so the
 * shell offers in-app sign-out; `proxy` mode has the trusted proxy own identity
 * and no app session to revoke (UX only — never an authz signal).
 *
 * This is the browser-side mirror of the wire contract. The source of truth is
 * `AuthMode` in `@canvas-drop/shared` (derived from the `CANVAS_DROP_AUTH_MODE`
 * config enum), which `/api/me` serializes. The dashboard does NOT depend on the
 * shared/config package (it reads `process.env` and pulls in zod + the server
 * schema — server code must never enter the browser bundle), so this union is
 * intentionally restated here. Keep the two in lockstep if a mode is ever added. */
export type AuthMode = "proxy" | "oidc" | "dev";

export interface Me {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  authMode: AuthMode;
}

/** The four toggleable backend features (plan 006). Identity is implicit (no flag). */
export type FeatureCapability = "kv" | "files" | "ai" | "realtime";

/** Raw stored per-feature flags (independent of backend/global state). */
export type StoredCapabilities = Record<FeatureCapability, boolean>;

/** Effective on/off per capability after the server ANDs backend + flag + globals. */
export type EffectiveCapabilities = Record<FeatureCapability | "identity", boolean>;

/** Capability patch sent to PATCH /:id/capabilities (all optional). */
export interface CanvasCapabilitiesPatch {
  backendEnabled?: boolean;
  kv?: boolean;
  files?: boolean;
  ai?: boolean;
  realtime?: boolean;
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
  /** Backend-group master switch (plan 006). */
  backendEnabled: boolean;
  /** Raw stored feature flags (what the toggles control). */
  capabilities: StoredCapabilities;
  /** Effective state after the server ANDs backend + flag + operator globals. */
  effective: EffectiveCapabilities;
  status: string;
  /** Admin takedown reason (§6.10.2) — owner/admin-only; null unless disabled. */
  disabledReason: string | null;
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

/** What a version serves at the canvas root (computed server-side). `path` is
 *  the entry file; null with reason "ambiguous"/"none" means the root 404s. */
export interface RootEntry {
  path: string | null;
  reason: "index" | "single" | "ambiguous" | "none";
}

export interface VersionInfo {
  number: number;
  source: string;
  status: string;
  createdBy: string;
  createdAt: number;
  fileCount: number;
  totalBytes: number;
  current: boolean;
  entry: RootEntry;
}

export interface DeployResult {
  url: string;
  version: number;
  fileCount: number;
  totalBytes: number;
  warnings: string[];
}

/** Per-canvas usage figures (D24) — KV ops + file storage (M6), AI + realtime (M9). */
export interface CanvasUsage {
  kvOps: number;
  fileOps: number;
  fileCount: number;
  fileBytes: number;
  aiCalls: number;
  aiTokens: number;
  aiCostUsd: number;
  realtimeConnects: number;
}

/** One file in the draft (no bytes — those load on demand via getDraftFile). */
export interface DraftFile {
  path: string;
  size: number;
  mime: string;
}

/** Editor draft state (M5): file list + publish/stale flags. */
export interface DraftView {
  files: DraftFile[];
  stale: boolean;
  baseVersionId: string | null;
  updatedAt: number;
  /** The draft differs from the live published version (unpublished changes). */
  dirty: boolean;
}

export interface PublishResult {
  version: number;
  versionId: string;
  fileCount: number;
  totalBytes: number;
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

/** One canvas as it appears in the opt-in gallery (M8) — display-only fields. */
export interface GalleryItem {
  id: string;
  slug: string;
  url: string;
  title: string;
  summary: string | null;
  tags: string[];
  hasPassword: boolean;
  publishedAt: number | null;
  owner: { name: string; avatarUrl: string | null };
}

/** A page of gallery results. `limit`/`offset` are echoed by the server so the
 *  view derives "showing X–Y of N" from the authoritative values, not a guess. */
export interface GalleryPage {
  items: GalleryItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface GalleryQuery {
  q?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

/** Gallery page size: the client's `limit` AND the page→offset divisor. One
 *  constant so the page math can never desync from the requested page size. */
export const GALLERY_PAGE_SIZE = 24;

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
  PATH_EXISTS: "A file already exists at that path — pick a different name.",
  VERSION_UNAVAILABLE: "That version was just removed — refresh and pick another.",
  invalid_body: "Some fields were invalid — check and try again.",
  NOT_ARCHIVED: "This canvas isn't archived — refresh and try again.",
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
        // Mirror request()'s isAuthExpiry: a 2xx response whose body isn't JSON
        // means a proxy served its HTML login page (KTD-8).
        const ct = xhr.getResponseHeader("content-type") ?? "";
        if (!ct.includes("application/json")) {
          onAuthExpired();
          reject(new ApiError("unauthorized", "Session expired", undefined, xhr.status));
          return;
        }
        try {
          return resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          onAuthExpired();
          reject(new ApiError("unauthorized", "Session expired", undefined, xhr.status));
          return;
        }
      }
      reject(errorFromBody(xhr.status, xhr.statusText, xhr.responseText));
    };
    xhr.onerror = () => reject(new ApiError("network_error", "Network error"));
    xhr.timeout = 300_000;
    xhr.ontimeout = () =>
      reject(new ApiError("timeout", "Upload timed out — check your connection and try again."));
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

// --- Admin surface (§6.10, M7). Only reachable by an admin user; the server
//     404s non-admins, and the UI hides the entry behind `me.isAdmin`. ---

export type AdminCanvasStatus = "active" | "disabled" | "archived" | "deleted";

export interface AdminCanvasRow {
  id: string;
  slug: string;
  url: string;
  title: string;
  status: string;
  disabledReason: string | null;
  owner: { id: string; email: string; name: string } | null;
  sizeBytes: number;
  usageOps: number;
  lastActivityAt: number;
  createdAt: number;
  /** Soft-delete timestamp; null unless status === "deleted". Drives the purge-age hint. */
  deletedAt: number | null;
}

/** One keyset page of the admin all-canvases list. `nextCursor === null` ⇒ last page. */
export interface AdminCanvasPage {
  canvases: AdminCanvasRow[];
  nextCursor: string | null;
}

export interface AdminOverview {
  canvasCountByStatus: Record<string, number>;
  userCount: number;
  totalFileBytes: number;
  /** Total recorded primitive ops across the platform (all time). */
  totalOps: number;
  /** Canvases created within the last `recentWindowDays` days. */
  newCanvases: number;
  /** Users first seen within the last `recentWindowDays` days. */
  newUsers: number;
  /** The window (days) the `new*` counts span. */
  recentWindowDays: number;
  /** Oldest soft-deleted canvas's `deletedAt` (purge backlog age); null if none pending. */
  oldestDeletedAt: number | null;
  topCanvases: Array<{ canvasId: string; ops: number; slug: string | null; title: string | null }>;
}

/** One row of the admin Configuration view. Secrets never carry a raw `value`. */
export interface AdminConfigField {
  key: string;
  env: string;
  group: string;
  label: string;
  help?: string;
  type: "string" | "number" | "boolean" | "enum" | "csv";
  enumValues?: string[];
  secret: boolean;
  editable: boolean;
  source: "database" | "environment" | "default";
  overridden: boolean;
  /** Non-secret effective value (display string). Absent for secrets. */
  value?: string;
  /** Secret-only: configured? + last 4 chars. Never the value. */
  set?: boolean;
  last4?: string;
}

export const api = {
  me: () => request<Me>("/api/me"),

  /** Browse the opt-in gallery (M8). Empty params are omitted from the query string. */
  listGallery: (query: GalleryQuery = {}) => {
    const sp = new URLSearchParams();
    if (query.q) sp.set("q", query.q);
    if (query.tag) sp.set("tag", query.tag);
    if (query.limit !== undefined) sp.set("limit", String(query.limit));
    if (query.offset !== undefined) sp.set("offset", String(query.offset));
    const qs = sp.toString();
    return request<GalleryPage>(`/api/gallery${qs ? `?${qs}` : ""}`);
  },

  listCanvases: () =>
    request<{ canvases: CanvasListItem[] }>("/api/canvases").then((r) => r.canvases),

  listArchivedCanvases: () =>
    request<{ canvases: CanvasListItem[] }>("/api/canvases/archived").then((r) => r.canvases),

  getCanvas: (id: string) => request<Canvas>(`/api/canvases/${id}`),

  getUsage: (id: string) => request<CanvasUsage>(`/api/canvases/${id}/usage`),

  createCanvas: (body: { title?: string; description?: string; backendEnabled?: boolean }) =>
    request<Canvas & { apiKey: string }>("/api/canvases", jsonBody(body)),

  pasteHtml: (body: { html: string; title?: string; backendEnabled?: boolean }) =>
    request<Canvas & { apiKey: string; deploy: DeployResult }>(
      "/api/canvases/paste",
      jsonBody(body),
    ),

  deployZip: (id: string, zip: ArrayBuffer, onProgress?: (fraction: number) => void) =>
    xhrUpload<DeployResult>("POST", `/api/canvases/${id}/deploy/zip`, zip, onProgress),

  deployFolder: (id: string, form: FormData, onProgress?: (fraction: number) => void) =>
    xhrUpload<DeployResult>("POST", `/api/canvases/${id}/deploy/folder`, form, onProgress),

  deployPaste: (id: string, html: string) =>
    request<DeployResult>(`/api/canvases/${id}/deploy/paste`, jsonBody({ html })),

  updateSettings: (id: string, patch: CanvasSettings) =>
    request<Canvas>(`/api/canvases/${id}/settings`, { ...jsonBody(patch), method: "PATCH" }),

  updateCapabilities: (id: string, patch: CanvasCapabilitiesPatch) =>
    request<Canvas>(`/api/canvases/${id}/capabilities`, { ...jsonBody(patch), method: "PATCH" }),

  regenerateSlug: (id: string) =>
    request<Canvas>(`/api/canvases/${id}/regenerate-slug`, { method: "POST" }),

  regenerateKey: (id: string) =>
    request<{ apiKey: string }>(`/api/canvases/${id}/regenerate-key`, { method: "POST" }),

  deleteCanvas: (id: string) => request<{ ok: true }>(`/api/canvases/${id}`, { method: "DELETE" }),

  archiveCanvas: (id: string) => request<Canvas>(`/api/canvases/${id}/archive`, { method: "POST" }),

  unarchiveCanvas: (id: string) =>
    request<Canvas>(`/api/canvases/${id}/unarchive`, { method: "POST" }),

  listVersions: (id: string) =>
    request<{ versions: VersionInfo[] }>(`/api/canvases/${id}/versions`).then((r) => r.versions),

  rollback: (id: string, version: number) =>
    request<Canvas & { version: number }>(`/api/canvases/${id}/rollback`, jsonBody({ version })),

  // --- In-browser editor / draft (M5) ---
  getDraft: (id: string) => request<DraftView>(`/api/canvases/${id}/draft`),

  /**
   * Load a draft file's text content (owner-only, never cached). Unlike JSON
   * endpoints, the body is legitimately non-JSON (HTML/CSS/JS), so auth-expiry is
   * narrowed to 401 / a redirect to login — NOT the generic "2xx non-JSON" rule,
   * which would misread every successful file load as a session expiry.
   */
  getDraftFile: async (id: string, path: string): Promise<string> => {
    const res = await fetch(`/api/canvases/${id}/draft/file?path=${encodeURIComponent(path)}`, {
      credentials: "include",
    });
    if (res.status === 401 || res.redirected) {
      onAuthExpired();
      throw new ApiError("unauthorized", "Session expired", undefined, res.status);
    }
    if (!res.ok) throw await parseError(res);
    return res.text();
  },

  /** Write/replace a draft file (raw text body). Returns the refreshed draft view.
   * `opts.signal` lets best-effort callers (e.g. the editor's unmount flush) bound the
   * request so a hung server can't leave the PUT pending indefinitely.
   * `opts.expectedBaseVersionId` pins the draft fork-point this edit was based on: the
   * server rejects with 409 DRAFT_CONFLICT if a restore (or any wholesale replace) has
   * since moved `baseVersionId`, so a stale flush can't clobber the new draft. A `null`
   * base (draft forked from no live version) is sent as the `none` sentinel. */
  putDraftFile: (
    id: string,
    path: string,
    content: string,
    opts?: { signal?: AbortSignal; expectedBaseVersionId?: string | null },
  ) =>
    request<DraftView>(`/api/canvases/${id}/draft/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        ...(opts && "expectedBaseVersionId" in opts
          ? { "If-Draft-Base": opts.expectedBaseVersionId ?? "none" }
          : {}),
      },
      body: content,
      signal: opts?.signal,
    }),

  /**
   * Create a NEW empty draft file ("Add a file"). `mode=create` makes the server
   * refuse an existing path (PATH_EXISTS) instead of overwriting it — so the Add
   * action can never silently truncate a file that's already there.
   */
  createDraftFile: (id: string, path: string) =>
    request<DraftView>(
      `/api/canvases/${id}/draft/file?path=${encodeURIComponent(path)}&mode=create`,
      { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "" },
    ),

  /** Replace/upload a draft file with raw bytes (binary-safe — images, fonts, etc.). */
  uploadDraftFile: (id: string, path: string, body: Blob) =>
    request<DraftView>(`/api/canvases/${id}/draft/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      body,
    }),

  deleteDraftFile: (id: string, path: string) =>
    request<DraftView>(`/api/canvases/${id}/draft/file?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),

  renameDraftFile: (id: string, from: string, to: string) =>
    request<DraftView>(`/api/canvases/${id}/draft/rename`, jsonBody({ from, to })),

  publishDraft: (id: string) =>
    request<PublishResult>(`/api/canvases/${id}/publish`, { method: "POST" }),

  restoreToDraft: (id: string, version: number) =>
    request<DraftView>(`/api/canvases/${id}/restore`, jsonBody({ version })),

  // --- Admin (§6.10, M7) ---
  admin: {
    /** One keyset page; pass the previous page's `nextCursor` to fetch the next. */
    listCanvases: (status?: AdminCanvasStatus, cursor?: string) => {
      const sp = new URLSearchParams();
      if (status) sp.set("status", status);
      if (cursor) sp.set("cursor", cursor);
      const qs = sp.toString();
      return request<AdminCanvasPage>(`/api/admin/canvases${qs ? `?${qs}` : ""}`);
    },

    overview: () => request<AdminOverview>("/api/admin/overview"),

    disableCanvas: (id: string, reason: string) =>
      request<{ ok: true }>(`/api/admin/canvases/${id}/disable`, jsonBody({ reason })),

    enableCanvas: (id: string) =>
      request<{ ok: true }>(`/api/admin/canvases/${id}/enable`, { method: "POST" }),

    // Un-soft-delete (distinct from the draft revert-to-version `restoreToDraft`).
    restoreCanvas: (id: string) =>
      request<{ ok: true }>(`/api/admin/canvases/${id}/restore`, { method: "POST" }),

    /** The unified Configuration view: every setting with value/source/secret-mask. */
    getConfig: () =>
      request<{ fields: AdminConfigField[] }>("/api/admin/config").then((r) => r.fields),

    /** Set a DB override for an editable setting (server validates + coerces). */
    setConfig: (key: string, value: string | number | boolean | string[]) =>
      request<{ ok: true }>(`/api/admin/config/${encodeURIComponent(key)}`, {
        ...jsonBody({ value }),
        method: "PUT",
      }),

    /** Clear a setting's DB override (revert to env/default). */
    clearConfig: (key: string) =>
      request<{ ok: true }>(`/api/admin/config/${encodeURIComponent(key)}`, { method: "DELETE" }),
  },
};
