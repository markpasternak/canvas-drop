import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, setAuthExpiredHandler } from "../lib/api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Minimal XMLHttpRequest stand-in for the XHR upload path (deployZip/Folder). */
class FakeXHR {
  static status = 200;
  static body = "{}";
  upload: { onprogress?: (e: ProgressEvent) => void; onload?: () => void } = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  statusText = "";
  responseText = "";
  withCredentials = false;
  open() {}
  setRequestHeader() {}
  send() {
    this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
    this.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 10 } as ProgressEvent);
    this.upload.onload?.();
    this.status = FakeXHR.status;
    this.responseText = FakeXHR.body;
    this.onload?.();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api error handling", () => {
  it("deploy upload (XHR) maps a stable error code to a typed ApiError with a hint", async () => {
    FakeXHR.status = 400;
    FakeXHR.body = JSON.stringify({ code: "ZIP_SLIP_REJECTED", message: "bad path" });
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    await expect(api.deployZip("c1", new ArrayBuffer(4))).rejects.toMatchObject({
      code: "ZIP_SLIP_REJECTED",
    });
    try {
      await api.deployZip("c1", new ArrayBuffer(4));
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).hint).toMatch(/unsafe path/i);
    }
  });

  it("deploy upload (XHR) reports byte progress and resolves the deploy result", async () => {
    FakeXHR.status = 200;
    FakeXHR.body = JSON.stringify({ url: "u", version: 1, fileCount: 1, totalBytes: 10 });
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const seen: number[] = [];
    const result = await api.deployZip("c1", new ArrayBuffer(4), (f) => seen.push(f));
    expect(result.version).toBe(1);
    expect(seen).toContain(0.5); // 5/10 bytes
    expect(seen).toContain(1); // upload complete → server processing
  });

  it("deployPaste posts the html to the canvas's deploy/paste endpoint", async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method, body: init?.body as string });
        return jsonResponse({ url: "u", version: 2, fileCount: 1, totalBytes: 9 });
      }),
    );
    const res = await api.deployPaste("c1", "<h1>v2</h1>");
    expect(res.version).toBe(2);
    expect(calls[0]?.url).toBe("/api/canvases/c1/deploy/paste");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toContain("v2");
  });

  it("distinguishes 404 not_found from 403 cross_origin_forbidden", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "not_found" }, 404)),
    );
    await expect(api.getCanvas("x")).rejects.toMatchObject({ code: "not_found", status: 404 });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "cross_origin_forbidden" }, 403)),
    );
    await expect(api.rollback("x", 1)).rejects.toMatchObject({
      code: "cross_origin_forbidden",
      status: 403,
    });
  });

  it("a 401 triggers the auth-expiry handler (full-page login), not an in-SPA error", async () => {
    const onExpired = vi.fn();
    setAuthExpiredHandler(onExpired);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    await expect(api.listCanvases()).rejects.toMatchObject({ code: "unauthorized" });
    expect(onExpired).toHaveBeenCalledOnce();
  });

  it("a 200 HTML body (proxy served its login page) is treated as auth-expiry", async () => {
    const onExpired = vi.fn();
    setAuthExpiredHandler(onExpired);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<!doctype html><title>Login</title>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    await expect(api.me()).rejects.toMatchObject({ code: "unauthorized" });
    expect(onExpired).toHaveBeenCalledOnce();
  });

  it("a 5xx HTML error page is NOT auth-expiry (surfaces a normal error)", async () => {
    const onExpired = vi.fn();
    setAuthExpiredHandler(onExpired);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>boom</html>", {
            status: 503,
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    await expect(api.listCanvases()).rejects.toBeInstanceOf(ApiError);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("a redirect to an HTML login page is treated as auth-expiry", async () => {
    const onExpired = vi.fn();
    setAuthExpiredHandler(onExpired);
    const html = new Response("<!doctype html><title>Login</title>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    Object.defineProperty(html, "redirected", { value: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => html),
    );
    await expect(api.me()).rejects.toMatchObject({ code: "unauthorized" });
    expect(onExpired).toHaveBeenCalledOnce();
  });
});
