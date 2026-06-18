import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
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

type Handler = (init?: RequestInit) => Response;
const calls: Array<{ method: string; path: string }> = [];

function mockFetch(handlers: Record<string, Handler>) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const u = new URL(url, "http://localhost");
      calls.push({ method, path: u.pathname + u.search });
      return (
        handlers[`${method} ${u.pathname}${u.search}`]?.(init) ??
        handlers[`${method} ${u.pathname}`]?.(init) ??
        json({ error: "not_mocked" }, 500)
      );
    }),
  );
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
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

const ME = { id: "u-me", email: "me@x", name: "Me", avatarUrl: null, isAdmin: true };
const userRow = (over: Record<string, unknown>) => ({
  id: "u-bob",
  email: "bob@example.com",
  name: "Bob",
  avatarUrl: null,
  isAdmin: false,
  isBlocked: false,
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  canvasCount: 1,
  ...over,
});

function usersPage(users: unknown[]) {
  return json({ users, total: users.length, limit: 50, offset: 0 });
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("admin users", () => {
  it("renders the user table with canvas count, role, and status", async () => {
    mockFetch({
      "GET /api/me": () => json(ME),
      "GET /api/admin/users": () =>
        usersPage([
          userRow({ id: "u-me", email: "me@x", name: "Me", isAdmin: true, canvasCount: 3 }),
          userRow({}),
        ]),
    });
    renderAt("/admin/users");
    expect(await screen.findByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    // Role + status badges present (scope to the table — "Admin" is also a nav link).
    const table = screen.getByRole("table");
    expect(within(table).getByText("Admin")).toBeInTheDocument(); // the "Me" admin row
    expect(within(table).getAllByText("Active").length).toBeGreaterThanOrEqual(1);
    // Per-user owned-canvas count column.
    expect(within(table).getAllByText("3").length).toBeGreaterThanOrEqual(1);
  });

  it("blocks a user via the row action", async () => {
    mockFetch({
      "GET /api/me": () => json(ME),
      "GET /api/admin/users": () =>
        usersPage([userRow({ id: "u-me", email: "me@x", name: "Me", isAdmin: true }), userRow({})]),
      "POST /api/admin/users/u-bob/block": () => json({ ok: true }),
    });
    renderAt("/admin/users");
    const user = userEvent.setup();
    await screen.findByText("Bob");
    // Open Bob's row overflow menu (me's own row blocks itself), then Block.
    await user.click(screen.getByRole("button", { name: "Actions for Bob" }));
    await user.click(await screen.findByRole("menuitem", { name: "Block user" }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.path === "/api/admin/users/u-bob/block"),
      ).toBe(true),
    );
  });

  it("self-protection: your own row can't be blocked or demoted", async () => {
    mockFetch({
      "GET /api/me": () => json(ME),
      "GET /api/admin/users": () =>
        usersPage([userRow({ id: "u-me", email: "me@x", name: "Me", isAdmin: true })]),
    });
    renderAt("/admin/users");
    const user = userEvent.setup();
    // "Me" is the row's display name AND the signed-in account label shown in the
    // rail footer's account control, so scope the load wait to the user table.
    const table = await screen.findByRole("table");
    await within(table).findByText("Me");
    await user.click(screen.getByRole("button", { name: "Actions for Me" }));
    // Your own row's block + demote items are disabled (aria-disabled menuitems).
    expect(await screen.findByRole("menuitem", { name: "Block user" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "Remove admin access" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
