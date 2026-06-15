/**
 * @canvas-drop/sdk — the zero-config browser SDK exposed as the global
 * `canvasdrop` (plan 007 / M6, area J). Canvas code calls `canvasdrop.kv`,
 * `canvasdrop.files`, and `canvasdrop.me()`; the SDK derives the canvas slug +
 * API base from `location`, sends credentialed requests, and throws typed errors.
 * No secrets ever live here — identity rides the IAP/session cookie.
 */

export const SDK_VERSION = "1";

// ---------------------------------------------------------------------------
// Canonical machine-readable error codes (§11.5). This is the single source of
// truth the docs error table and its drift guard read — the `*Error` classes
// below cover only a subset, while several wire codes (KEY_LIMIT, VALUE_TOO_LARGE,
// AI_*, CONNECTION_LIMIT) are returned by the runtime API without a dedicated
// class. Keep this in lockstep with the server's emitted codes.
// ---------------------------------------------------------------------------

export const ERROR_CODES = {
  NOT_AUTHENTICATED: { status: 401, summary: "The viewer is not signed in." },
  PASSWORD_REQUIRED: { status: 403, summary: "The canvas is password-protected." },
  CAPABILITY_DISABLED: {
    status: 403,
    summary: "Backend or the specific feature is off for this canvas.",
  },
  CROSS_CANVAS_FORBIDDEN: {
    status: 403,
    summary: "A request targeted another canvas's resources.",
  },
  MODEL_NOT_ALLOWED: { status: 403, summary: "The requested AI model is not in the allow-list." },
  DISABLED: { status: 403, summary: "The canvas has been disabled by an administrator." },
  STATIC_ONLY: {
    status: 403,
    summary:
      "The canvas is a public link (public_link) — every backend primitive is refused for non-owners.",
  },
  GUEST_AI_DISABLED: {
    status: 403,
    summary: "The canvas owner has not enabled AI for invited guests.",
  },
  GUEST_AI_CAP: {
    status: 429,
    summary: "The canvas reached its guest-AI spend cap.",
  },
  NOT_FOUND: { status: 404, summary: "The key, file, or canvas does not exist." },
  INVALID_BODY: { status: 400, summary: "The request body failed validation." },
  KEY_TOO_LARGE: { status: 413, summary: "The KV key exceeds the size limit." },
  VALUE_TOO_LARGE: { status: 413, summary: "The KV value exceeds the size limit." },
  FILE_TOO_LARGE: { status: 413, summary: "An uploaded file exceeds the per-file size limit." },
  KEY_LIMIT: { status: 409, summary: "The canvas hit its key-count limit." },
  NOT_NUMERIC: { status: 409, summary: "increment was called on a non-numeric value." },
  QUOTA_EXCEEDED: { status: 429, summary: "A spend or rate quota was exceeded." },
  CONNECTION_LIMIT: { status: 429, summary: "Too many concurrent realtime connections." },
  AI_STREAM_TRUNCATED: { status: 502, summary: "An AI stream ended before completion." },
  AI_UPSTREAM_ERROR: { status: 502, summary: "The AI provider returned an error." },
  REQUEST_FAILED: { status: 0, summary: "A request failed without a more specific code." },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

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
  // Quota signalled either by code (AI: 429 QUOTA_EXCEEDED, or the per-canvas guest
  // AI cap: 429 GUEST_AI_CAP) or by the KV/files limit statuses (409 KEY_LIMIT,
  // 413 *_TOO_LARGE).
  if (code === "QUOTA_EXCEEDED" || code === "GUEST_AI_CAP" || status === 409 || status === 413) {
    return new QuotaExceededError(code || undefined, status);
  }
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
  port?: string;
}): CanvasContext {
  const pathMatch = PATH_RE.exec(loc.pathname);
  if (pathMatch) {
    // Path mode: `/c/{slug}/...` on a shared origin — call the same origin.
    return { slug: pathMatch[1] as string, apiBase: loc.origin };
  }
  // Subdomain mode: `{slug}.{base}` — slug is the first label; the API lives on
  // the base host (first label stripped), preserving any non-default port.
  const labels = loc.hostname.split(".");
  const slug = labels[0] as string;
  const baseHost = labels.slice(1).join(".");
  const port = loc.port ? `:${loc.port}` : "";
  return { slug, apiBase: `${loc.protocol}//${baseHost}${port}` };
}

// ---------------------------------------------------------------------------
// HTTP — credentialed fetch with typed error mapping.
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The browser `WebSocket` surface the realtime client depends on (the `onX`
 * setters — supported by both the browser global and the Node `ws` package).
 * Injectable for tests.
 */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface ClientOptions {
  context: CanvasContext;
  fetch?: FetchLike;
  /** WebSocket constructor for realtime (defaults to the global). Injectable for tests. */
  WebSocketImpl?: WebSocketFactory;
  /** Base reconnect backoff in ms (default 500; tests shrink it). */
  reconnectBaseMs?: number;
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
  /** Whether the viewer is an org `member` or an email-invited `guest` (U9). */
  kind: "member" | "guest";
}

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  mime?: string;
  createdAt?: number;
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

// --- AI primitive (§6.6) ----------------------------------------------------

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}
export interface AiChatOptions {
  model: string;
  system?: string;
  maxTokens?: number;
}
export interface AiResult {
  text: string;
  usage: AiUsage;
  cost: number;
}
export interface AiNamespace {
  /** Run a chat completion, accumulating the stream into the full text + usage. */
  chat(messages: AiMessage[], options: AiChatOptions): Promise<AiResult>;
  /** Stream the assistant's text deltas as an async iterator. */
  stream(messages: AiMessage[], options: AiChatOptions): AsyncIterable<string>;
}

// --- Realtime primitive (§6.7) ----------------------------------------------

export interface RealtimeUser {
  id: string;
  name: string;
}
export interface RealtimeMessage {
  event: string;
  data: unknown;
  from: RealtimeUser;
}
export interface Channel {
  publish(event: string, data: unknown): void;
  subscribe(handler: (msg: RealtimeMessage) => void): void;
  unsubscribe(): void;
  presence(): Promise<RealtimeUser[]>;
  onPresence(handler: (users: RealtimeUser[]) => void): void;
  onJoin(handler: (user: RealtimeUser) => void): void;
  onLeave(handler: (user: RealtimeUser) => void): void;
  /** Stop this channel; closes the shared socket when no channels remain. */
  close(): void;
}
export interface RealtimeNamespace {
  channel(name: string): Channel;
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
  ai: AiNamespace;
  realtime: RealtimeNamespace;
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

// ---------------------------------------------------------------------------
// AI — SSE parsing + typed errors.
// ---------------------------------------------------------------------------

type SseFrame = Record<string, unknown>;

/** Yield decoded `data:` JSON objects from an SSE response body. */
async function* readSSE(res: Response): AsyncGenerator<SseFrame> {
  if (!res.body) throw new CanvasdropError("NO_STREAM", res.status, "response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf("\n\n");
    while (idx !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) yield JSON.parse(line.slice(5).trim()) as SseFrame;
      }
      idx = buf.indexOf("\n\n");
    }
  }
}

/** Map an in-stream AI error frame to a typed, catchable error. */
function aiErrorFromFrame(frame: SseFrame): CanvasdropError {
  const code = typeof frame.code === "string" ? frame.code : "AI_ERROR";
  const message = typeof frame.message === "string" ? frame.message : undefined;
  if (code === "CAPABILITY_DISABLED") return new CapabilityDisabledError("ai");
  if (code === "QUOTA_EXCEEDED") return new QuotaExceededError(code);
  return new CanvasdropError(code, 502, message);
}

function aiNamespace(opts: Required<ClientOptions>, base: (p: string) => string): AiNamespace {
  async function open(messages: AiMessage[], options: AiChatOptions): Promise<Response> {
    const res = await opts.fetch(base("/ai/chat"), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages,
        system: options.system,
        maxTokens: options.maxTokens,
      }),
    });
    // Pre-stream failures (bad body / model / quota / capability) are JSON errors.
    if (!res.ok) throw errorFromResponse(res.status, await res.json().catch(() => null));
    return res;
  }
  return {
    async *stream(messages, options) {
      const res = await open(messages, options);
      let terminal = false;
      for await (const frame of readSSE(res)) {
        if (frame.type === "delta") yield String(frame.text ?? "");
        else if (frame.type === "error") throw aiErrorFromFrame(frame);
        else if (frame.type === "done") {
          terminal = true;
          return;
        }
      }
      // Stream ended without a done/error frame → truncated (proxy cut, server
      // tear-down). Surface it rather than silently returning a partial result.
      if (!terminal) throw new CanvasdropError("AI_STREAM_TRUNCATED", 502, "stream ended early");
    },
    async chat(messages, options) {
      const res = await open(messages, options);
      let text = "";
      let usage: AiUsage = { inputTokens: 0, outputTokens: 0 };
      let cost = 0;
      let terminal = false;
      for await (const frame of readSSE(res)) {
        if (frame.type === "delta") text += String(frame.text ?? "");
        else if (frame.type === "error") throw aiErrorFromFrame(frame);
        else if (frame.type === "done") {
          terminal = true;
          usage = (frame.usage as AiUsage) ?? usage;
          cost = typeof frame.cost === "number" ? frame.cost : 0;
        }
      }
      if (!terminal) throw new CanvasdropError("AI_STREAM_TRUNCATED", 502, "stream ended early");
      return { text, usage, cost };
    },
  };
}

// ---------------------------------------------------------------------------
// Realtime — one shared WebSocket per canvas, auto-reconnect, typed degradation.
// ---------------------------------------------------------------------------

interface ChannelState {
  subscribed: boolean;
  onMessage: Array<(m: RealtimeMessage) => void>;
  onPresence: Array<(u: RealtimeUser[]) => void>;
  onJoin: Array<(u: RealtimeUser) => void>;
  onLeave: Array<(u: RealtimeUser) => void>;
  presenceWaiters: Array<{ resolve: (u: RealtimeUser[]) => void; reject: (e: unknown) => void }>;
}

/** Max buffered outbound frames while disconnected (drop-oldest beyond this). */
const MAX_OUTBOX = 256;

/** ws:// (or wss://) base derived from the HTTP apiBase (D-RT-7 — same host). */
function wsBaseFrom(apiBase: string): string {
  return apiBase.replace(/^http/, "ws");
}

function createRealtime(opts: Required<ClientOptions>): RealtimeNamespace {
  const url = `${wsBaseFrom(opts.context.apiBase)}/v1/c/${opts.context.slug}/realtime`;
  const channels = new Map<string, ChannelState>();
  let ws: WebSocketLike | null = null;
  let connecting = false;
  let outbox: string[] = [];
  let backoff = opts.reconnectBaseMs;
  let terminal: CanvasdropError | null = null;

  function st(name: string): ChannelState {
    let s = channels.get(name);
    if (!s) {
      s = {
        subscribed: false,
        onMessage: [],
        onPresence: [],
        onJoin: [],
        onLeave: [],
        presenceWaiters: [],
      };
      channels.set(name, s);
    }
    return s;
  }

  function rawSend(frame: unknown): void {
    const data = JSON.stringify(frame);
    if (ws && !terminal && ws.readyState === 1) ws.send(data);
    else if (!terminal) {
      // Bound the buffer: during a prolonged outage a high-frequency publisher
      // (cursors, pings) would otherwise grow this without limit. Drop oldest.
      outbox.push(data);
      if (outbox.length > MAX_OUTBOX) outbox.splice(0, outbox.length - MAX_OUTBOX);
    }
  }

  function flush(): void {
    const pending = outbox;
    outbox = [];
    for (const d of pending) ws?.send(d);
  }

  /** Reject any in-flight presence() waiters so callers never hang on a dropped socket. */
  function rejectPendingPresence(err: unknown): void {
    for (const s of channels.values()) {
      for (const w of s.presenceWaiters) w.reject(err);
      s.presenceWaiters = [];
    }
  }

  function failTerminal(err: CanvasdropError): void {
    terminal = err;
    rejectPendingPresence(err);
  }

  function handleFrame(frame: SseFrame): void {
    const name = typeof frame.channel === "string" ? frame.channel : "";
    const s = name ? channels.get(name) : undefined;
    switch (frame.type) {
      case "message":
        if (s)
          for (const h of s.onMessage)
            h({
              event: String(frame.event ?? ""),
              data: frame.data,
              from: frame.from as RealtimeUser,
            });
        break;
      case "presence": {
        const users = (frame.users as RealtimeUser[]) ?? [];
        if (s) {
          for (const w of s.presenceWaiters) w.resolve(users);
          s.presenceWaiters = [];
          for (const h of s.onPresence) h(users);
        }
        break;
      }
      case "join":
        if (s) for (const h of s.onJoin) h(frame.user as RealtimeUser);
        break;
      case "leave":
        if (s) for (const h of s.onLeave) h(frame.user as RealtimeUser);
        break;
      case "error":
        if (frame.code === "CAPABILITY_DISABLED")
          failTerminal(new CapabilityDisabledError("realtime"));
        break;
    }
  }

  function connect(): void {
    if (ws || connecting || terminal || channels.size === 0) return;
    connecting = true;
    const sock = opts.WebSocketImpl(url);
    sock.onopen = () => {
      connecting = false;
      // All channels were closed while we were connecting → don't keep an orphan.
      if (channels.size === 0) {
        try {
          sock.close(1000, "no channels");
        } catch {
          /* already closed */
        }
        return;
      }
      ws = sock;
      backoff = opts.reconnectBaseMs;
      // Re-subscribe every channel (covers reconnect), then flush queued sends.
      for (const [name, s] of channels)
        if (s.subscribed) sock.send(JSON.stringify({ type: "subscribe", channel: name }));
      flush();
    };
    sock.onmessage = (ev) => {
      try {
        handleFrame(JSON.parse(String(ev.data)) as SseFrame);
      } catch {
        /* ignore malformed frame */
      }
    };
    sock.onclose = (ev) => {
      ws = null;
      connecting = false;
      // Terminal closes (no reconnect): 4403 capability-off, 4401 unauthorized,
      // 4429 connection/rate limit. Each rejects pending presence() waiters.
      if (ev.code === 4403) failTerminal(new CapabilityDisabledError("realtime"));
      else if (ev.code === 4401) failTerminal(new NotAuthenticatedError());
      else if (ev.code === 4429) failTerminal(new QuotaExceededError("CONNECTION_LIMIT", 429));
      if (terminal || channels.size === 0) return;
      // Transient close: reject in-flight presence() so callers retry instead of
      // hanging, then reconnect with capped backoff (channels re-subscribe on open).
      rejectPendingPresence(new CanvasdropError("DISCONNECTED", 0, "connection dropped; retry"));
      const delay = backoff;
      backoff = Math.min(backoff * 2, 10_000);
      setTimeout(connect, delay);
    };
    sock.onerror = () => {
      /* close handler drives reconnect */
    };
  }

  function makeChannel(name: string): Channel {
    return {
      publish(event, data) {
        if (terminal) throw terminal;
        connect();
        rawSend({ type: "publish", channel: name, event, data });
      },
      subscribe(handler) {
        const s = st(name);
        s.onMessage.push(handler);
        s.subscribed = true;
        connect();
        // If already open, subscribe now; otherwise the onopen handler re-subscribes
        // every `subscribed` channel (covers initial connect AND reconnect) — so we
        // must NOT also queue it here, or it would double-send.
        if (ws && ws.readyState === 1)
          ws.send(JSON.stringify({ type: "subscribe", channel: name }));
      },
      unsubscribe() {
        const s = channels.get(name);
        if (!s) return;
        s.subscribed = false;
        s.onMessage = [];
        rawSend({ type: "unsubscribe", channel: name });
      },
      presence() {
        if (terminal) return Promise.reject(terminal);
        const s = st(name);
        connect();
        return new Promise<RealtimeUser[]>((resolve, reject) => {
          s.presenceWaiters.push({ resolve, reject });
          rawSend({ type: "presence", channel: name });
        });
      },
      onPresence(handler) {
        st(name).onPresence.push(handler);
      },
      onJoin(handler) {
        st(name).onJoin.push(handler);
      },
      onLeave(handler) {
        st(name).onLeave.push(handler);
      },
      close() {
        channels.delete(name);
        rawSend({ type: "unsubscribe", channel: name });
        if (channels.size === 0 && ws) {
          ws.close(1000, "no channels");
          ws = null;
        }
      },
    };
  }

  return { channel: makeChannel };
}

/** Build a client for a resolved context (the testable core). */
export function createClient(options: ClientOptions): CanvasdropClient {
  const opts: Required<ClientOptions> = {
    context: options.context,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    WebSocketImpl: options.WebSocketImpl ?? ((u) => new WebSocket(u) as unknown as WebSocketLike),
    reconnectBaseMs: options.reconnectBaseMs ?? 500,
  };
  const shared = kvNamespace(opts, "/kv");
  const base = (p: string) => `${opts.context.apiBase}/v1/c/${opts.context.slug}${p}`;
  return {
    me: () => request<Me>(opts, "GET", "/me"),
    kv: { ...shared, user: kvNamespace(opts, "/kv/user") },
    ai: aiNamespace(opts, base),
    realtime: createRealtime(opts),
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
        const json = (await res.json()) as { id: string; name: string; size: number };
        // Build an absolute, mode-correct content URL (the server's `url` is
        // root-relative and would resolve to the canvas subdomain in subdomain mode).
        return { ...json, url: base(`/files/${encodeURIComponent(json.id)}/content`) };
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
