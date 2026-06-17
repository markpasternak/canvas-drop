import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

const BASE = {
  id: "c1",
  slug: "quiet-otter",
  url: "http://x/c/quiet-otter",
  title: "My Canvas",
  description: null,
  shared: false,
  sharedExpiresAt: null,
  hasPassword: false,
  spaFallback: false,
  previewMode: "auto",
  galleryListed: false,
  gallerySummary: null,
  galleryTags: null,
  status: "active",
  publicationState: "draft",
  disabledReason: null,
  currentVersionId: null,
  createdAt: 0,
  updatedAt: 0,
};

const OFF = {
  ...BASE,
  backendEnabled: false,
  capabilities: { kv: true, files: true, ai: true, realtime: true },
  effective: { identity: false, kv: false, files: false, ai: false, realtime: false },
};

const ON = {
  ...BASE,
  backendEnabled: true,
  capabilities: { kv: true, files: true, ai: true, realtime: true },
  effective: { identity: true, kv: true, files: true, ai: true, realtime: true },
};

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

function renderCapabilities() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/canvases/c1/capabilities"] }),
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("capabilities tab", () => {
  it("backend off: feature toggles are disabled and identity reads Off", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json(OFF) });
    renderCapabilities();
    expect(await screen.findByRole("switch", { name: "Enable backend" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("link", { name: "SDK docs" })).toHaveAttribute("href", "/docs");
    expect(screen.getByRole("switch", { name: /value storage/i })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "AI" })).toBeDisabled();
    expect(screen.getByText("Off")).toBeInTheDocument();
  });

  it("enabling backend PATCHes backendEnabled:true", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(OFF),
      "PATCH /api/canvases/c1/capabilities": () => json(ON),
    });
    const user = userEvent.setup();
    renderCapabilities();
    await user.click(await screen.findByRole("switch", { name: "Enable backend" }));
    await vi.waitFor(() => {
      const patch = calls.find((c) => c.url === "/api/canvases/c1/capabilities");
      expect(patch?.method).toBe("PATCH");
      expect(patch?.body).toContain('"backendEnabled":true');
    });
  });

  it("backend on: toggling a feature off PATCHes that flag", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(ON),
      "PATCH /api/canvases/c1/capabilities": () =>
        json({ ...ON, capabilities: { ...ON.capabilities, ai: false } }),
    });
    const user = userEvent.setup();
    renderCapabilities();
    const ai = await screen.findByRole("switch", { name: "AI" });
    expect(ai).not.toBeDisabled();
    await user.click(ai);
    await vi.waitFor(() => {
      const patch = calls.find((c) => c.url === "/api/canvases/c1/capabilities");
      expect(patch?.body).toContain('"ai":false');
    });
  });

  it("shows an operator-disabled hint when a stored feature is not effective", async () => {
    const gated = {
      ...ON,
      capabilities: { ...ON.capabilities, realtime: true },
      effective: { ...ON.effective, realtime: false },
    };
    mockFetch({ "GET /api/canvases/c1": () => json(gated) });
    renderCapabilities();
    expect(await screen.findByText(/disabled by your administrator/i)).toBeInTheDocument();
  });

  it("identity reads Always on when backend is enabled", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json(ON) });
    renderCapabilities();
    expect(await screen.findByText("Always on")).toBeInTheDocument();
  });

  it("warns that backend is inert when a public_link canvas has backend enabled", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json({ ...ON, access: "public_link" }) });
    renderCapabilities();
    expect(await screen.findByText(/won't run for public visitors/i)).toBeInTheDocument();
  });

  it("does NOT show the public-backend warning on a non-public canvas", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json({ ...ON, access: "private" }) });
    renderCapabilities();
    await screen.findByRole("switch", { name: "Enable backend" });
    expect(screen.queryByText(/won't run for public visitors/i)).not.toBeInTheDocument();
  });
});
