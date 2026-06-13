import { describe, expect, it, vi } from "vitest";
import {
  type CanvasContext,
  CapabilityDisabledError,
  createClient,
  detectContext,
  errorFromResponse,
  type FetchLike,
  NotAuthenticatedError,
  NotFoundError,
  QuotaExceededError,
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
});
