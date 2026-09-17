import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import type { AdminConnection, PublicConnectionPolicy } from "../lib/api.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Handler = (init?: RequestInit) => Response;
function mockFetch(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url, "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, path: parsed.pathname + parsed.search, body: init?.body as string });
      return handlers[`${method} ${parsed.pathname}`]?.(init) ?? json({ error: "not_mocked" }, 500);
    }),
  );
  return calls;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/admin/connections"] }),
  });
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <ToastProvider>
          {/* biome-ignore lint/suspicious/noExplicitAny: test router instance */}
          <RouterProvider router={router as any} />
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return client;
}

const PROFILE: AdminConnection = {
  id: "p1",
  key: "stocks",
  label: "Stock data",
  origin: "https://stocks.example.com",
  allowedMethods: ["GET"],
  protectedHeaders: [{ name: "user-agent", set: true }],
  encryptionKeyAvailable: true,
  enabled: true,
  affectedCanvasCount: 2,
  createdAt: 1,
  updatedAt: 1,
};

const ME = {
  id: "admin",
  email: "admin@example.com",
  name: "Admin",
  avatarUrl: null,
  isAdmin: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin connections", () => {
  it("requires explicit endpoint, method and cap before enabling a public grant, and can revoke it", async () => {
    let publicPolicy: PublicConnectionPolicy | null = null;
    const calls = mockFetch({
      "GET /api/me": () => json(ME),
      "GET /api/admin/connections": () => json({ connections: [PROFILE] }),
      "GET /api/admin/connections/health": () => json({ sinceMs: 1, profiles: [] }),
      "GET /api/admin/canvases": () => json({ canvases: [], total: 0 }),
      "GET /api/admin/connections/p1/canvases": () =>
        json({
          canvases: [
            {
              id: "c1",
              slug: "margin",
              title: "Margin",
              publicPolicy,
              publicDay: 0,
              publicRequests: 0,
            },
          ],
        }),
      "GET /api/admin/connections/p1/events": () => json({ events: [], limit: 25, offset: 0 }),
      "PUT /api/admin/connections/p1/canvases/c1/public": (init) => {
        publicPolicy = JSON.parse(String(init?.body)).policy;
        return json({ publicPolicy });
      },
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Manage" }));
    expect(await screen.findByText("Public access off")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Configure public access" }));
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    await user.type(screen.getByLabelText("Public endpoint paths"), "/quote");
    await user.clear(screen.getByLabelText("Public requests per day"));
    await user.type(screen.getByLabelText("Public requests per day"), "2000");
    await user.click(screen.getByRole("button", { name: "Enable public access" }));
    expect(await screen.findByText("Public access enabled")).toBeInTheDocument();
    expect(publicPolicy).toEqual({ paths: ["/quote"], methods: ["GET"], requestsPerDay: 2000 });
    await user.click(screen.getByRole("button", { name: "Disable public access" }));
    expect(await screen.findByText("Public access off")).toBeInTheDocument();
    expect(publicPolicy).toBeNull();
  });
  it("shows observed failures, named canvases and a bounded diagnostic outcome", async () => {
    const calls = mockFetch({
      "GET /api/me": () => json(ME),
      "GET /api/admin/connections": () =>
        json({ connections: [{ ...PROFILE, allowedMethods: ["HEAD"] }] }),
      "GET /api/admin/connections/health": () =>
        json({
          sinceMs: 1,
          profiles: [
            {
              profileId: "p1",
              requests: 4,
              successes: 3,
              failures: 1,
              averageDurationMs: 80,
              lastSuccessAt: 1000,
              lastFailureAt: 500,
              affectedCanvasCount: 1,
            },
          ],
        }),
      "GET /api/admin/connections/p1/canvases": () => json({ canvases: [] }),
      "GET /api/admin/connections/p1/events": () =>
        json({
          events: [
            {
              id: "e1",
              canvasId: "c1",
              canvasTitle: "Market board",
              createdAt: 500,
              outcome: "upstream_server_error",
              upstreamStatus: 503,
              durationMs: 80,
            },
          ],
          limit: 25,
          offset: 0,
        }),
      "GET /api/admin/canvases": () => json({ canvases: [], total: 0 }),
      "POST /api/admin/connections/p1/diagnose": () =>
        json({ outcome: "upstream_status", upstreamStatus: 401, durationMs: 20, checkedAt: 1000 }),
    });
    renderPage();
    const user = userEvent.setup();
    expect(await screen.findByText("Failures observed")).toBeInTheDocument();
    expect(screen.getByText("80 ms")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(await screen.findByRole("link", { name: "Market board" })).toHaveAttribute(
      "href",
      expect.stringContaining("inspect=c1"),
    );
    await user.type(screen.getByRole("textbox", { name: "Diagnostic path" }), "health");
    await user.click(screen.getByRole("button", { name: "Run HEAD diagnostic" }));
    expect(await screen.findByText(/HTTP 401/)).toBeInTheDocument();
    expect(JSON.parse(calls.find((call) => call.method === "POST")?.body ?? "{}")).toEqual({
      path: "/health",
    });
    expect(screen.getByText("Rotate protected credentials")).toBeInTheDocument();
  });

  it("distinguishes no recent traffic from unavailable health data", async () => {
    const handlers = {
      "GET /api/me": () => json(ME),
      "GET /api/admin/connections": () => json({ connections: [PROFILE] }),
      "GET /api/admin/connections/health": () => json({ sinceMs: 1, profiles: [] }),
      "GET /api/admin/canvases": () => json({ canvases: [], total: 0 }),
    };
    mockFetch(handlers);
    const client = renderPage();
    expect(await screen.findByText("No recent traffic")).toBeInTheDocument();
    mockFetch({
      ...handlers,
      "GET /api/admin/connections/health": () => json({ error: "unavailable" }, 503),
    });
    await client.invalidateQueries({ queryKey: ["admin", "connection-health"] });
    expect(await screen.findByText(/Observed health is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("No recent traffic")).not.toBeInTheDocument();
  });

  it("creates a GET stock profile and never reloads its protected value into the DOM or cache", async () => {
    let profiles: AdminConnection[] = [];
    const calls = mockFetch({
      "GET /api/me": () => json(ME),
      "GET /api/admin/connections": () => json({ connections: profiles }),
      "GET /api/admin/canvases": () => json({ canvases: [], total: 0, limit: 10, offset: 0 }),
      "POST /api/admin/connections": (init) => {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          key: "stocks",
          origin: "https://stocks.example.com",
          allowedMethods: ["GET"],
          protectedHeaders: [{ name: "User-Agent", value: "CanvasStocks/1.0" }],
        });
        profiles = [PROFILE];
        return json({ connection: PROFILE }, 201);
      },
    });
    const client = renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New connection" }));
    await user.type(screen.getByLabelText("Profile key"), "stocks");
    await user.type(screen.getByLabelText("Display name"), "Stock data");
    await user.type(screen.getByLabelText("Exact HTTPS origin"), "https://stocks.example.com");
    await user.click(screen.getByRole("button", { name: "Add header" }));
    await user.type(screen.getByLabelText("Header 1 name"), "User-Agent");
    await user.type(screen.getByLabelText("Header 1 value"), "CanvasStocks/1.0");
    await user.click(screen.getByRole("button", { name: "Create connection" }));
    expect(await screen.findByRole("heading", { name: "Stock data" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("CanvasStocks/1.0")).not.toBeInTheDocument();
    expect(screen.queryByText("CanvasStocks/1.0")).not.toBeInTheDocument();
    expect(JSON.stringify(client.getQueryData(["admin", "connections"]))).not.toContain(
      "CanvasStocks/1.0",
    );
    expect(calls.some((call) => call.method === "POST")).toBe(true);
  });

  it("names the affected canvases before disabling a live profile", async () => {
    const calls = mockFetch({
      "GET /api/me": () => json(ME),
      "GET /api/admin/connections": () => json({ connections: [PROFILE] }),
      "GET /api/admin/canvases": () => json({ canvases: [], total: 0, limit: 10, offset: 0 }),
      "PUT /api/admin/connections/p1": () => json({ connection: { ...PROFILE, enabled: false } }),
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disable" }));
    expect(
      screen.getByText(/takes effect immediately for 2 granted canvases/i),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Disable connection" }));
    await waitFor(() => {
      expect(calls.find((call) => call.method === "PUT")?.body).toContain('"enabled":false');
    });
  });

  it("grants a searched canvas and invalidates the profile authority", async () => {
    const canvas = { id: "c1", slug: "ticker", title: "Ticker" };
    const calls = mockFetch({
      "GET /api/me": () => json(ME),
      "GET /api/admin/connections": () => json({ connections: [PROFILE] }),
      "GET /api/admin/canvases": () => json({ canvases: [canvas], total: 1, limit: 10, offset: 0 }),
      "GET /api/admin/connections/p1/canvases": () => json({ canvases: [] }),
      "GET /api/admin/connections/p1/events": () => json({ events: [], limit: 25, offset: 0 }),
      "PUT /api/admin/connections/p1/canvases/c1": () =>
        json({ attached: true, connection: { key: "stocks" } }),
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Manage" }));
    await user.click(await screen.findByRole("button", { name: "Grant" }));
    await waitFor(() =>
      expect(calls.some((call) => call.path === "/api/admin/connections/p1/canvases/c1")).toBe(
        true,
      ),
    );
  });
});
