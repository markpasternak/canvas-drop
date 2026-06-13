import { describe, expect, it, vi } from "vitest";
import {
  type CanvasContext,
  CanvasdropError,
  CapabilityDisabledError,
  createClient,
  detectContext,
  errorFromResponse,
  type FetchLike,
  NotAuthenticatedError,
  NotFoundError,
  QuotaExceededError,
  type RealtimeMessage,
  type WebSocketLike,
} from "./index.js";

function res(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = (impl?: FetchLike) => vi.fn<FetchLike>(impl ?? (async () => res(200, {})));

const ctx: CanvasContext = { slug: "foo", apiBase: "https://canvases.example.com" };

describe("detectContext", () => {
  it("path mode: /c/{slug}/ → slug + same-origin API base", () => {
    expect(
      detectContext({
        hostname: "localhost",
        pathname: "/c/foo/index.html",
        origin: "http://localhost:3000",
        protocol: "http:",
      }),
    ).toEqual({ slug: "foo", apiBase: "http://localhost:3000" });
  });

  it("subdomain mode: {slug}.{base} → slug + base-host API base", () => {
    expect(
      detectContext({
        hostname: "foo.canvases.example.com",
        pathname: "/",
        origin: "https://foo.canvases.example.com",
        protocol: "https:",
      }),
    ).toEqual({ slug: "foo", apiBase: "https://canvases.example.com" });
  });

  it("subdomain mode preserves a non-default port in the API base", () => {
    expect(
      detectContext({
        hostname: "foo.canvases.localhost",
        pathname: "/",
        origin: "http://foo.canvases.localhost:3000",
        protocol: "http:",
        port: "3000",
      }),
    ).toEqual({ slug: "foo", apiBase: "http://canvases.localhost:3000" });
  });
});

describe("errorFromResponse", () => {
  it("maps statuses/codes to typed errors", () => {
    expect(errorFromResponse(401, null)).toBeInstanceOf(NotAuthenticatedError);
    expect(errorFromResponse(404, null)).toBeInstanceOf(NotFoundError);
    expect(errorFromResponse(409, { code: "QUOTA_EXCEEDED" })).toBeInstanceOf(QuotaExceededError);
    expect(errorFromResponse(413, { code: "VALUE_TOO_LARGE" })).toBeInstanceOf(QuotaExceededError);
    const cap = errorFromResponse(403, { code: "CAPABILITY_DISABLED", capability: "kv" });
    expect(cap).toBeInstanceOf(CapabilityDisabledError);
    expect(cap.code).toBe("CAPABILITY_DISABLED");
  });
});

describe("createClient", () => {
  it("me() GETs the right URL with credentials and parses JSON", async () => {
    const fetch = fetchMock(async () =>
      res(200, { id: "u1", email: "a@b.c", name: "A", avatarUrl: null }),
    );
    const client = createClient({ context: ctx, fetch });
    const me = await client.me();
    expect(me.id).toBe("u1");
    expect(fetch).toHaveBeenCalledWith(
      "https://canvases.example.com/v1/c/foo/me",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("kv.set PUTs the value; kv.get returns it; missing → null", async () => {
    const fetch = fetchMock()
      .mockResolvedValueOnce(res(200, { ok: true })) // set
      .mockResolvedValueOnce(res(200, { value: 42 })) // get
      .mockResolvedValueOnce(res(404, { error: "not_found" })); // get missing
    const client = createClient({ context: ctx, fetch });
    await client.kv.set("n", 42);
    expect(await client.kv.get("n")).toBe(42);
    expect(await client.kv.get("missing")).toBeNull();
    expect(fetch.mock.calls[0]?.[0]).toBe("https://canvases.example.com/v1/c/foo/kv/n");
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("PUT");
  });

  it("kv.increment POSTs and returns the running total", async () => {
    const fetch = fetchMock(async () => res(200, { value: 5 }));
    const client = createClient({ context: ctx, fetch });
    expect(await client.kv.increment("votes", 5)).toBe(5);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://canvases.example.com/v1/c/foo/kv/votes/increment",
    );
  });

  it("kv.user.* targets the per-user namespace", async () => {
    const fetch = fetchMock(async () => res(200, { ok: true }));
    const client = createClient({ context: ctx, fetch });
    await client.kv.user.set("pref", "dark");
    expect(fetch.mock.calls[0]?.[0]).toBe("https://canvases.example.com/v1/c/foo/kv/user/pref");
  });

  it("a disabled capability throws CapabilityDisabledError", async () => {
    const fetch = fetchMock(async () =>
      res(403, { code: "CAPABILITY_DISABLED", capability: "kv" }),
    );
    const client = createClient({ context: ctx, fetch });
    await expect(client.kv.get("x")).rejects.toBeInstanceOf(CapabilityDisabledError);
  });

  it("files.url() builds the content path synchronously", () => {
    const client = createClient({ context: ctx, fetch: fetchMock() });
    expect(client.files.url("abc")).toBe("https://canvases.example.com/v1/c/foo/files/abc/content");
  });

  it("files.upload() returns an absolute content url (not the server's root-relative one)", async () => {
    const fetch = fetchMock(async () =>
      res(201, { id: "abc", name: "a.txt", size: 3, url: "/v1/c/foo/files/abc/content" }),
    );
    const client = createClient({ context: ctx, fetch });
    const result = await client.files.upload(new File(["abc"], "a.txt", { type: "text/plain" }));
    expect(result.url).toBe("https://canvases.example.com/v1/c/foo/files/abc/content");
  });
});

// --- AI ----------------------------------------------------------------------

/** An SSE Response streaming the given frames as `data:` lines. */
function sseRes(frames: object[]): Response {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("ai", () => {
  it("chat() accumulates deltas and returns usage + cost", async () => {
    const fetch = fetchMock(async () =>
      sseRes([
        { type: "delta", text: "Hel" },
        { type: "delta", text: "lo" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 3 }, cost: 0.0123 },
      ]),
    );
    const client = createClient({ context: ctx, fetch });
    const r = await client.ai.chat([{ role: "user", content: "hi" }], {
      model: "claude-haiku-4-5",
    });
    expect(r.text).toBe("Hello");
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    expect(r.cost).toBeCloseTo(0.0123, 6);
  });

  it("stream() yields the text deltas", async () => {
    const fetch = fetchMock(async () =>
      sseRes([
        { type: "delta", text: "a" },
        { type: "delta", text: "b" },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, cost: 0 },
      ]),
    );
    const client = createClient({ context: ctx, fetch });
    const out: string[] = [];
    for await (const d of client.ai.stream([{ role: "user", content: "hi" }], {
      model: "claude-haiku-4-5",
    })) {
      out.push(d);
    }
    expect(out).toEqual(["a", "b"]);
  });

  it("maps an in-stream error frame to a typed error", async () => {
    const fetch = fetchMock(async () =>
      sseRes([
        { type: "delta", text: "x" },
        { type: "error", code: "AI_UPSTREAM_ERROR", message: "boom" },
      ]),
    );
    const client = createClient({ context: ctx, fetch });
    await expect(
      client.ai.chat([{ role: "user", content: "hi" }], { model: "claude-haiku-4-5" }),
    ).rejects.toBeInstanceOf(CanvasdropError);
  });

  it("maps a pre-stream 403 to CapabilityDisabledError, 429 to QuotaExceededError", async () => {
    const offClient = createClient({
      context: ctx,
      fetch: fetchMock(async () => res(403, { code: "CAPABILITY_DISABLED", capability: "ai" })),
    });
    await expect(
      offClient.ai.chat([{ role: "user", content: "hi" }], { model: "claude-haiku-4-5" }),
    ).rejects.toBeInstanceOf(CapabilityDisabledError);

    const quotaClient = createClient({
      context: ctx,
      fetch: fetchMock(async () => res(429, { code: "QUOTA_EXCEEDED", scope: "user_daily" })),
    });
    await expect(
      quotaClient.ai.chat([{ role: "user", content: "hi" }], { model: "claude-haiku-4-5" }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });
});

// --- Realtime ----------------------------------------------------------------

class FakeWS implements WebSocketLike {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason });
  }
  // test controls
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function realtimeClient() {
  FakeWS.instances = [];
  const client = createClient({
    context: ctx,
    fetch: fetchMock(),
    WebSocketImpl: (u) => new FakeWS(u),
    reconnectBaseMs: 1,
  });
  return client;
}
const lastWs = () => FakeWS.instances[FakeWS.instances.length - 1] as FakeWS;

describe("realtime", () => {
  it("derives a wss URL from the apiBase, on the same host", () => {
    const client = realtimeClient();
    client.realtime.channel("room").subscribe(() => {});
    expect(lastWs().url).toBe("wss://canvases.example.com/v1/c/foo/realtime");
  });

  it("subscribe + incoming message round-trip", async () => {
    const client = realtimeClient();
    const got: RealtimeMessage[] = [];
    client.realtime.channel("room").subscribe((m) => got.push(m));
    lastWs().open();
    expect(lastWs().sent).toContainEqual({ type: "subscribe", channel: "room" });
    lastWs().emit({
      type: "message",
      channel: "room",
      event: "ping",
      data: 1,
      from: { id: "u", name: "U" },
    });
    expect(got).toEqual([{ event: "ping", data: 1, from: { id: "u", name: "U" } }]);
  });

  it("presence() resolves with the server's snapshot", async () => {
    const client = realtimeClient();
    const ch = client.realtime.channel("room");
    const p = ch.presence();
    lastWs().open();
    lastWs().emit({ type: "presence", channel: "room", users: [{ id: "a", name: "A" }] });
    await expect(p).resolves.toEqual([{ id: "a", name: "A" }]);
  });

  it("re-subscribes after a transient reconnect", async () => {
    const client = realtimeClient();
    client.realtime.channel("room").subscribe(() => {});
    lastWs().open();
    const first = lastWs();
    first.serverClose(1006); // abnormal close → reconnect
    await new Promise((r) => setTimeout(r, 10));
    const second = lastWs();
    expect(second).not.toBe(first);
    second.open();
    expect(second.sent).toContainEqual({ type: "subscribe", channel: "room" });
  });

  it("a 4403 close is terminal — presence rejects with CapabilityDisabledError, no reconnect", async () => {
    const client = realtimeClient();
    const ch = client.realtime.channel("room");
    ch.subscribe(() => {});
    lastWs().open();
    const sock = lastWs();
    sock.serverClose(4403);
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeWS.instances).toHaveLength(1); // did not reconnect
    await expect(ch.presence()).rejects.toBeInstanceOf(CapabilityDisabledError);
  });

  it("close() then publish() does not reconnect", async () => {
    const client = realtimeClient();
    const ch = client.realtime.channel("room");
    ch.subscribe(() => {});
    lastWs().open();
    ch.close();
    const count = FakeWS.instances.length;
    ch.publish("x", 1);
    expect(FakeWS.instances.length).toBe(count); // no new socket for a closed channel
  });
});
