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
  tags: null,
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

function renderAt(initialPath = "/canvases/c1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
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
    renderAt();
    expect(await screen.findByText(/an administrator disabled this canvas/i)).toBeInTheDocument();
    expect(screen.getAllByText("Terms of service violation").length).toBeGreaterThan(0);
  });

  it("shows no takedown notice on an active canvas", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(BASE),
      "GET /api/canvases/c1/versions": () => json({ versions: [] }),
    });
    renderAt();
    await screen.findByText(/overview/i);
    expect(screen.queryByText(/an administrator disabled/i)).not.toBeInTheDocument();
  });

  it("shows the shell-level read-only takedown banner on the canvas detail (every tab)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...BASE, status: "disabled", disabledReason: "Abuse report" }),
      "GET /api/canvases/c1/versions": () => json({ versions: [] }),
    });
    renderAt();
    // The shell banner names the takedown and explains the read-only state + reason.
    expect(
      await screen.findByText(/this canvas has been disabled by an administrator/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/it is read-only/i)).toBeInTheDocument();
    expect(screen.getAllByText("Abuse report").length).toBeGreaterThan(0);
  });

  it("the editor tab is read-only on a disabled canvas (editing paused, no publish)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...BASE, status: "disabled", disabledReason: "Abuse report" }),
      "GET /api/canvases/c1/versions": () => json({ versions: [] }),
      "GET /api/canvases/c1/draft": () =>
        json({ files: [], stale: false, dirty: false, baseVersionId: null, updatedAt: 0 }),
    });
    renderAt("/canvases/c1/editor");
    // The editor refuses to load its surface and explains it's read-only (status-aware copy).
    expect(await screen.findByText(/editing is paused/i)).toBeInTheDocument();
    expect(
      screen.getByText(/an administrator disabled this canvas, so it's read-only/i),
    ).toBeInTheDocument();
  });
});
