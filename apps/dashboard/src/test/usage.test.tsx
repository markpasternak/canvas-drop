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
  capabilities: { kv: true, files: true, ai: true, realtime: true },
  effective: { identity: true, kv: true, files: true, ai: false, realtime: true },
  status: "active",
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

function renderUsage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/canvases/c1/usage"] }),
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

describe("usage tab", () => {
  it("renders KV-op, file-storage, AI and realtime figures when backend is on", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json({ ...BASE, backendEnabled: true }),
      "GET /api/canvases/c1/usage": () =>
        json({
          kvOps: 1280,
          fileOps: 12,
          fileCount: 3,
          fileBytes: 2048,
          aiCalls: 4,
          aiTokens: 5120,
          aiCostUsd: 0.0034,
          realtimeConnects: 9,
        }),
    });
    renderUsage();
    expect(await screen.findByText("1,280")).toBeInTheDocument(); // KV ops
    expect(await screen.findByText("2.0 KB")).toBeInTheDocument(); // file storage
    expect(screen.getByText(/3 files/)).toBeInTheDocument();
    expect(screen.getByText("$0.0034")).toBeInTheDocument(); // AI cost (sub-cent precision)
    expect(screen.getByText(/5,120 tokens/)).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument(); // realtime connects
  });

  it("shows the empty state (pointing at Capabilities) when backend is off", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json({ ...BASE, backendEnabled: false }),
    });
    renderUsage();
    expect(await screen.findByText(/No backend usage yet/i)).toBeInTheDocument();
  });
});
