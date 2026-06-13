/**
 * @canvas-drop/sdk — the zero-config browser SDK exposed as the global
 * `canvasdrop` (plan 007 / M6, area J). Canvas code calls `canvasdrop.kv`,
 * `canvasdrop.files`, and `canvasdrop.me()`; the SDK derives the canvas slug +
 * API base from `location`, sends credentialed requests, and throws typed errors.
 * No secrets ever live here — identity rides the IAP/session cookie.
 */

export const SDK_VERSION = "1";

// ---------------------------------------------------------------------------
// Typed errors (§6.7). The 403 CAPABILITY_DISABLED maps to CapabilityDisabledError.
// ---------------------------------------------------------------------------

export class CanvasdropError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    this.name = "CanvasdropError";
    this.code = code;
    this.status = status;
  }
}
export class CapabilityDisabledError extends CanvasdropError {
  constructor(capability?: string) {
    super("CAPABILITY_DISABLED", 403, `capability disabled: ${capability ?? "unknown"}`);
    this.name = "CapabilityDisabledError";
  }
}
export class QuotaExceededError extends CanvasdropError {
  constructor(code = "QUOTA_EXCEEDED", status = 409) {
    super(code, status, "quota exceeded");
    this.name = "QuotaExceededError";
  }
}
export class NotFoundError extends CanvasdropError {
  constructor() {
    super("NOT_FOUND", 404, "not found");
    this.name = "NotFoundError";
  }
}
export class NotAuthenticatedError extends CanvasdropError {
  constructor() {
    super("NOT_AUTHENTICATED", 401, "not authenticated");
    this.name = "NotAuthenticatedError";
  }
}

/** Map an HTTP response (status + parsed body) to a typed error. */
export function errorFromResponse(status: number, body: unknown): CanvasdropError {
  const code =
    typeof body === "object" && body && "code" in body
      ? String((body as { code: unknown }).code)
      : "";
  if (status === 401) return new NotAuthenticatedError();
  if (status === 403 && code === "CAPABILITY_DISABLED") {
    const cap =
      typeof body === "object" && body && "capability" in body
        ? String((body as { capability: unknown }).capability)
        : undefined;
    return new CapabilityDisabledError(cap);
  }
  if (status === 404) return new NotFoundError();
  if (status === 409 || status === 413) return new QuotaExceededError(code || undefined, status);
  return new CanvasdropError(code || "REQUEST_FAILED", status);
}

// ---------------------------------------------------------------------------
// Context detection — slug + API base from the canvas's own location.
// ---------------------------------------------------------------------------

export interface CanvasContext {
  slug: string;
  /** Origin to call the API on. Path mode: same origin. Subdomain mode: the base host. */
  apiBase: string;
}

const PATH_RE = /^\/c\/([^/]+)/;

/** Derive the canvas context from a `Location`-like object. */
export function detectContext(loc: {
  hostname: string;
  pathname: string;
  origin: string;
  protocol: string;
}): CanvasContext {
  const pathMatch = PATH_RE.exec(loc.pathname);
  if (pathMatch) {
    // Path mode: `/c/{slug}/...` on a shared origin — call the same origin.
    return { slug: pathMatch[1] as string, apiBase: loc.origin };
  }
  // Subdomain mode: `{slug}.{base}` — slug is the first label; the API lives on
  // the base host (first label stripped).
  const labels = loc.hostname.split(".");
  const slug = labels[0] as string;
  const baseHost = labels.slice(1).join(".");
  return { slug, apiBase: `${loc.protocol}//${baseHost}` };
}

// ---------------------------------------------------------------------------
// HTTP — credentialed fetch with typed error mapping.
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  context: CanvasContext;
  fetch?: FetchLike;
}

async function request<T>(
  opts: Required<ClientOptions>,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${opts.context.apiBase}/v1/c/${opts.context.slug}${path}`;
  const init: RequestInit = { method, credentials: "include" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await opts.fetch(url, init);
  if (!res.ok) {
    const parsed = await res.json().catch(() => null);
    throw errorFromResponse(res.status, parsed);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Primitives.
// ---------------------------------------------------------------------------

export interface Me {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  mime?: string;
}

export interface KvList {
  entries: Array<{ key: string; value: unknown }>;
  nextCursor: string | null;
}

export interface KvNamespace {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<KvList>;
  increment(key: string, by?: number): Promise<number>;
}

export interface CanvasdropClient {
  me(): Promise<Me>;
  kv: KvNamespace & { readonly user: KvNamespace };
  files: {
    upload(file: File): Promise<{ id: string; name: string; size: number; url: string }>;
    list(): Promise<FileMeta[]>;
    delete(id: string): Promise<void>;
    url(id: string): string;
  };
}

function kvNamespace(opts: Required<ClientOptions>, base: string): KvNamespace {
  const enc = (k: string) => encodeURIComponent(k);
  return {
    async get<T>(key: string) {
      try {
        const r = await request<{ value: T }>(opts, "GET", `${base}/${enc(key)}`);
        return r.value;
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
    },
    async set(key: string, value: unknown) {
      await request(opts, "PUT", `${base}/${enc(key)}`, value);
    },
    async delete(key: string) {
      await request(opts, "DELETE", `${base}/${enc(key)}`);
    },
    list(o: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const q = new URLSearchParams();
      if (o.prefix) q.set("prefix", o.prefix);
      if (o.cursor) q.set("cursor", o.cursor);
      if (o.limit) q.set("limit", String(o.limit));
      const qs = q.toString();
      return request<KvList>(opts, "GET", `${base}${qs ? `?${qs}` : ""}`);
    },
    async increment(key: string, by = 1) {
      const r = await request<{ value: number }>(opts, "POST", `${base}/${enc(key)}/increment`, {
        by,
      });
      return r.value;
    },
  };
}

/** Build a client for a resolved context (the testable core). */
export function createClient(options: ClientOptions): CanvasdropClient {
  const opts: Required<ClientOptions> = {
    context: options.context,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
  };
  const shared = kvNamespace(opts, "/kv");
  const base = (p: string) => `${opts.context.apiBase}/v1/c/${opts.context.slug}${p}`;
  return {
    me: () => request<Me>(opts, "GET", "/me"),
    kv: { ...shared, user: kvNamespace(opts, "/kv/user") },
    files: {
      async upload(file: File) {
        const form = new FormData();
        form.set("file", file);
        const res = await opts.fetch(base("/files"), {
          method: "POST",
          credentials: "include",
          body: form,
        });
        if (!res.ok) throw errorFromResponse(res.status, await res.json().catch(() => null));
        return (await res.json()) as { id: string; name: string; size: number; url: string };
      },
      async list() {
        const r = await request<{ files: FileMeta[] }>(opts, "GET", "/files");
        return r.files;
      },
      async delete(id: string) {
        await request(opts, "DELETE", `/files/${encodeURIComponent(id)}`);
      },
      url(id: string) {
        return base(`/files/${encodeURIComponent(id)}/content`);
      },
    },
  };
}
