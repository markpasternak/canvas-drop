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
  previewMode: "auto",
  galleryListed: false,
  gallerySummary: null,
  galleryTags: null,
  capabilities: { kv: true, files: true, ai: true, realtime: true },
  effective: { identity: true, kv: true, files: true, ai: false, realtime: true },
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

/** A dense 30-day sparkline series whose counts sum to `total`. */
function viewsByDay(total: number): Array<{ dayMs: number; count: number }> {
  const DAY = 24 * 60 * 60 * 1000;
  const start = 1_700_000_000_000;
  return Array.from({ length: 30 }, (_, i) => ({
    dayMs: start + i * DAY,
    count: i === 29 ? total : 0,
  }));
}

describe("usage tab", () => {
  it("renders view stats + sparkline and primitive figures when backend is on", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json({ ...BASE, backendEnabled: true }),
      "GET /api/canvases/c1/usage": () =>
        json({
          totalViews: 42,
          uniqueViewers: 7,
          lastViewedAt: 1_700_000_000_000,
          viewsByDay: viewsByDay(42),
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
    expect(await screen.findByText("42")).toBeInTheDocument(); // total views
    expect(screen.getByText(/7 unique/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Views over the last/i })).toBeInTheDocument();
    expect(screen.getByText("1,280")).toBeInTheDocument(); // KV ops
    expect(screen.getByText("2.0 KB")).toBeInTheDocument(); // file storage
    expect(screen.getByText("$0.0034")).toBeInTheDocument(); // AI cost (sub-cent precision)
    expect(screen.getByText("9")).toBeInTheDocument(); // realtime connects
  });

  it("shows views (and a backend hint, not primitives) when backend is off", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json({ ...BASE, backendEnabled: false }),
      "GET /api/canvases/c1/usage": () =>
        json({
          totalViews: 3,
          uniqueViewers: 2,
          lastViewedAt: 1_700_000_000_000,
          viewsByDay: viewsByDay(3),
          kvOps: 0,
          fileOps: 0,
          fileCount: 0,
          fileBytes: 0,
          aiCalls: 0,
          aiTokens: 0,
          aiCostUsd: 0,
          realtimeConnects: 0,
        }),
    });
    renderUsage();
    // Views render regardless of backend (KTD-5); the query DOES fire now.
    expect(await screen.findByText("3")).toBeInTheDocument(); // total views
    expect(screen.getByText(/2 unique/)).toBeInTheDocument();
    expect(screen.getByText(/Turn on/i)).toBeInTheDocument();
    expect(screen.queryByText("KV operations")).not.toBeInTheDocument();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/usage"))).toBe(true);
  });

  it("shows a no-views empty state (and no sparkline) for a never-viewed canvas", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json({ ...BASE, backendEnabled: true }),
      "GET /api/canvases/c1/usage": () =>
        json({
          totalViews: 0,
          uniqueViewers: 0,
          lastViewedAt: null,
          viewsByDay: viewsByDay(0),
          kvOps: 0,
          fileOps: 0,
          fileCount: 0,
          fileBytes: 0,
          aiCalls: 0,
          aiTokens: 0,
          aiCostUsd: 0,
          realtimeConnects: 0,
        }),
    });
    renderUsage();
    expect(await screen.findByText(/No views yet/i)).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument(); // last viewed
    expect(screen.queryByRole("img", { name: /Views over the last/i })).not.toBeInTheDocument();
  });
});
