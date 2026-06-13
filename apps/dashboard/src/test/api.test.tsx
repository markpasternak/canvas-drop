import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, setAuthExpiredHandler } from "../lib/api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api error handling", () => {
  it("maps a stable deploy error code to a typed ApiError with a hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "ZIP_SLIP_REJECTED", message: "bad path" }, 400)),
    );
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
