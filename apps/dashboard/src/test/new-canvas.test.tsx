import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handlers: Record<string, () => Response>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url, "http://localhost").pathname;
    calls.push({ method, url: path, body: init?.body as string | undefined });
    const handler = handlers[`${method} ${path}`];
    if (handler) return handler();
    return json({ error: "not_mocked" }, 500);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function renderNew() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/new"] }),
  });
  render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          {/* biome-ignore lint/suspicious/noExplicitAny: test router instance */}
          <RouterProvider router={router as any} />
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("create flow — backend choice", () => {
  it("defaults the backend toggle to off", async () => {
    mockFetch({});
    renderNew();
    expect(await screen.findByRole("switch", { name: "Enable backend" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("creating via paste with backend enabled sends backendEnabled:true", async () => {
    const calls = mockFetch({
      "POST /api/canvases/paste": () =>
        json({ id: "c1", slug: "s", url: "http://x/c/s", apiKey: "cd_k", deploy: { version: 1 } }),
    });
    const user = userEvent.setup();
    renderNew();

    await user.click(await screen.findByRole("switch", { name: "Enable backend" }));
    await user.type(await screen.findByLabelText("HTML"), "<h1>hi</h1>");
    await user.click(screen.getByRole("button", { name: /create & deploy/i }));

    await vi.waitFor(() => {
      const post = calls.find((c) => c.url === "/api/canvases/paste");
      expect(post?.body).toContain('"backendEnabled":true');
    });
  });

  it("the API (blank-create) path threads backendEnabled to POST /api/canvases", async () => {
    const calls = mockFetch({
      "POST /api/canvases": () =>
        json({ id: "c1", slug: "s", url: "http://x/c/s", apiKey: "cd_k" }),
    });
    const user = userEvent.setup();
    renderNew();

    await user.click(await screen.findByRole("switch", { name: "Enable backend" }));
    await user.click(screen.getByRole("button", { name: /use the api/i }));
    await user.click(screen.getByRole("button", { name: /create & get a key/i }));

    await vi.waitFor(() => {
      const post = calls.find((c) => c.url === "/api/canvases");
      expect(post?.method).toBe("POST");
      expect(post?.body).toContain('"backendEnabled":true');
    });
  });

  it("creating via paste without enabling backend sends backendEnabled:false", async () => {
    const calls = mockFetch({
      "POST /api/canvases/paste": () =>
        json({ id: "c1", slug: "s", url: "http://x/c/s", apiKey: "cd_k", deploy: { version: 1 } }),
    });
    const user = userEvent.setup();
    renderNew();

    await user.type(await screen.findByLabelText("HTML"), "<h1>hi</h1>");
    await user.click(screen.getByRole("button", { name: /create & deploy/i }));

    await vi.waitFor(() => {
      const post = calls.find((c) => c.url === "/api/canvases/paste");
      expect(post?.body).toContain('"backendEnabled":false');
    });
  });
});
