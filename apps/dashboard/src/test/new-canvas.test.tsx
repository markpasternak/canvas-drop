import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
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
    expect(await screen.findByRole("switch", { name: /enable backend/i })).toHaveAttribute(
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

    await user.click(await screen.findByRole("switch", { name: /enable backend/i }));
    await user.type(await screen.findByLabelText("HTML"), "<h1>hi</h1>");
    await user.click(screen.getByRole("button", { name: /create and publish/i }));

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

    await user.click(await screen.findByRole("switch", { name: /enable backend/i }));
    await user.click(screen.getByRole("button", { name: /use the api/i }));
    await user.click(screen.getByRole("button", { name: /create key/i }));

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
    await user.click(screen.getByRole("button", { name: /create and publish/i }));

    await vi.waitFor(() => {
      const post = calls.find((c) => c.url === "/api/canvases/paste");
      expect(post?.body).toContain('"backendEnabled":false');
    });
  });
});

describe("create flow — source-first ordering (U16)", () => {
  it("renders the source/method choice before the backend toggle", async () => {
    mockFetch({});
    renderNew();

    // The source/method picker (the four methods) is present.
    const methodRegion = await screen.findByRole("region", { name: /creation method/i });
    const pasteButton = within(methodRegion).getByRole("button", { name: /paste html/i });
    const backendSwitch = await screen.findByRole("switch", { name: /enable backend/i });

    // DOM order: the source choice precedes the backend toggle.
    const position = pasteButton.compareDocumentPosition(backendSwitch);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("frames the backend toggle as optional", async () => {
    mockFetch({});
    renderNew();
    expect(
      await screen.findByRole("switch", { name: /enable backend \(optional\)/i }),
    ).toBeInTheDocument();
  });

  it("the API path surfaces a deploy curl snippet before creating, then the one-time key after", async () => {
    const calls = mockFetch({
      "POST /api/canvases": () =>
        json({ id: "c1", slug: "s", url: "http://x/c/s", apiKey: "cd_one_time_key" }),
    });
    const user = userEvent.setup();
    renderNew();

    // Choose the agent/script path.
    await user.click(await screen.findByRole("button", { name: /use the api/i }));

    // The curl deploy snippet is surfaced up front (before any key exists).
    expect(await screen.findByText(/what you'll run/i)).toBeInTheDocument();
    const preCreate = document.body.textContent ?? "";
    expect(preCreate).toContain("/v1/canvases/");
    expect(preCreate).toContain("deploy");

    // Creating reveals the real one-time key + a working curl snippet.
    await user.click(screen.getByRole("button", { name: /create key/i }));
    expect(await screen.findByText("cd_one_time_key")).toBeInTheDocument();
    await vi.waitFor(() => {
      const postCreate = document.body.textContent ?? "";
      expect(postCreate).toContain("c1");
      expect(postCreate).toContain("/v1/canvases/c1/deploy");
    });
    expect(calls.find((c) => c.url === "/api/canvases")?.method).toBe("POST");
  });

  it("an unavailable slug blocks creation (slug validation still gates submit)", async () => {
    const calls = mockFetch({
      // Slug availability check returns unavailable.
      "GET /api/canvases/slug-available": () => json({ available: false }),
      "POST /api/canvases/paste": () =>
        json({ id: "c1", slug: "s", url: "http://x/c/s", apiKey: "cd_k", deploy: { version: 1 } }),
    });
    const user = userEvent.setup();
    renderNew();

    await user.type(await screen.findByLabelText("HTML"), "<h1>hi</h1>");
    const slugInput = await screen.findByLabelText(/custom slug|slug/i);
    await user.type(slugInput, "taken-slug");

    // Wait for the availability check to resolve as unavailable, which blocks submit.
    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: /create and publish/i })).toBeDisabled();
    });

    await user.click(screen.getByRole("button", { name: /create and publish/i }));
    // No create call fired while the slug is unavailable.
    expect(calls.find((c) => c.url === "/api/canvases/paste")).toBeUndefined();
  });
});
