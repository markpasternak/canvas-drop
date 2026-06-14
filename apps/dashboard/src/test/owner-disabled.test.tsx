import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

const BASE = {
  id: "c1",
  slug: "app",
  url: "http://x/c/app",
  title: "App",
  description: null,
  shared: false,
  sharedExpiresAt: null,
  hasPassword: false,
  spaFallback: false,
  galleryListed: false,
  gallerySummary: null,
  galleryTags: null,
  backendEnabled: false,
  capabilities: { kv: true, files: true, ai: true, realtime: true },
  effective: { identity: false, kv: false, files: false, ai: false, realtime: false },
  status: "active",
  publicationState: "draft",
  disabledReason: null,
  currentVersionId: null,
  createdAt: 0,
  updatedAt: 0,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handlers: Record<string, () => Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url, "http://localhost").pathname;
      return handlers[`${method} ${path}`]?.() ?? json({ error: "not_mocked" }, 500);
    }),
  );
}

function renderOverview() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/canvases/c1"] }),
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

describe("owner sees takedown reason (R3)", () => {
  it("renders the disabledReason on the owner's own disabled canvas", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...BASE, status: "disabled", disabledReason: "Terms of service violation" }),
      "GET /api/canvases/c1/versions": () => json({ versions: [] }),
    });
    renderOverview();
    expect(await screen.findByText(/an administrator disabled this canvas/i)).toBeInTheDocument();
    expect(screen.getByText("Terms of service violation")).toBeInTheDocument();
  });

  it("shows no takedown notice on an active canvas", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(BASE),
      "GET /api/canvases/c1/versions": () => json({ versions: [] }),
    });
    renderOverview();
    await screen.findByText(/status/i);
    expect(screen.queryByText(/an administrator disabled/i)).not.toBeInTheDocument();
  });
});
