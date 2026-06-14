import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
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
const calls: Array<{ method: string; path: string; body?: string }> = [];

function mockFetch(handlers: Record<string, Handler>) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path =
        new URL(url, "http://localhost").pathname + new URL(url, "http://localhost").search;
      calls.push({ method, path, body: init?.body as string | undefined });
      const key = `${method} ${new URL(url, "http://localhost").pathname}`;
      return (
        handlers[`${method} ${path}`]?.(init) ??
        handlers[key]?.(init) ??
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

const ROW = {
  id: "c1",
  slug: "happy-otter",
  url: "http://x/c/happy-otter",
  title: "Happy Otter",
  status: "active",
  disabledReason: null,
  owner: { id: "u1", email: "alice@example.com", name: "Alice" },
  sizeBytes: 2048,
  usageOps: 1280,
  lastActivityAt: Date.now(),
  createdAt: Date.now(),
};

const OVERVIEW = {
  canvasCountByStatus: { active: 3, disabled: 1 },
  userCount: 7,
  totalFileBytes: 4096,
  topCanvases: [{ canvasId: "c1", ops: 1280, slug: "happy-otter", title: "Happy Otter" }],
};

afterEach(() => vi.restoreAllMocks());

describe("admin dashboard", () => {
  it("shows the Admin nav link only when me.isAdmin", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/canvases": () => json({ canvases: [ROW], nextCursor: null }),
      "GET /api/canvases": () => json({ canvases: [] }),
    });
    renderAt("/admin");
    expect(await screen.findByRole("link", { name: "Admin" })).toBeInTheDocument();
  });

  it("hides the Admin nav link for a non-admin", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: false }),
      "GET /api/canvases": () => json({ canvases: [] }),
    });
    renderAt("/");
    // The list page settles; the Admin link must never appear.
    await screen.findByRole("link", { name: "Archived" });
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("renders overview stats + the all-canvases table", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/canvases": () => json({ canvases: [ROW], nextCursor: null }),
    });
    renderAt("/admin");
    expect(await screen.findByText("Happy Otter")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument(); // user count
    expect(screen.getByText("2.0 KB")).toBeInTheDocument(); // row size
  });

  it("pages the canvas list: Load more fetches the next keyset page with the cursor", async () => {
    const PAGE2 = { ...ROW, id: "c2", slug: "brave-newt", title: "Brave Newt" };
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      // First page reports more rows (nextCursor = last id); the cursored second
      // page closes it out (nextCursor null).
      "GET /api/admin/canvases": (init) => {
        // path-keyed handlers are matched first, so a bare key with no query
        // string serves the first page; the cursored page hits the path key below.
        void init;
        return json({ canvases: [ROW], nextCursor: "c1" });
      },
      "GET /api/admin/canvases?cursor=c1": () => json({ canvases: [PAGE2], nextCursor: null }),
    });
    renderAt("/admin");
    const user = userEvent.setup();
    expect(await screen.findByText("Happy Otter")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Brave Newt")).toBeInTheDocument();
    // First page still on screen (appended, not replaced); the cursor was sent.
    expect(screen.getByText("Happy Otter")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/admin/canvases?cursor=c1")).toBe(true);
    // No further pages → the button is gone.
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("switching the status filter resets paging: a new keyset query, no stale Load more", async () => {
    const ACTIVE_ROW = { ...ROW, id: "a1", slug: "lone-active", title: "Lone Active" };
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      // "All" has more pages (Load more shows); the Active filter is a single page.
      "GET /api/admin/canvases": () => json({ canvases: [ROW], nextCursor: "c1" }),
      "GET /api/admin/canvases?status=active": () =>
        json({ canvases: [ACTIVE_ROW], nextCursor: null }),
    });
    renderAt("/admin");
    const user = userEvent.setup();
    expect(await screen.findByText("Happy Otter")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Active" }));
    // New query key (status=active) → pages reset to just the active page.
    expect(await screen.findByText("Lone Active")).toBeInTheDocument();
    expect(screen.queryByText("Happy Otter")).not.toBeInTheDocument();
    // The "all" view's cursor must not bleed through: no Load more for the single page.
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("takedown flow: opens the reason dialog, then POSTs disable with the reason", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/canvases": () => json({ canvases: [ROW], nextCursor: null }),
      "POST /api/admin/canvases/c1/disable": () => json({ ok: true }),
    });
    renderAt("/admin");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disable" }));
    const reason = await screen.findByLabelText("Reason");
    await user.type(reason, "abusive");
    await user.click(screen.getByRole("button", { name: "Disable canvas" }));
    await waitFor(() => {
      const call = calls.find((c) => c.path === "/api/admin/canvases/c1/disable");
      expect(call).toBeTruthy();
      expect(JSON.parse(call?.body ?? "{}").reason).toBe("abusive");
    });
  });

  it("settings page saves the model allowlist", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/settings/models": () =>
        json({ models: ["claude-fast"], override: null, default: ["claude-fast"] }),
      "GET /api/admin/settings/quotas": () => json({ quotas: [] }),
      "PUT /api/admin/settings/models": () => json({ models: ["m1", "m2"] }),
    });
    renderAt("/admin/settings");
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Allowed models");
    await user.clear(field);
    await user.type(field, "m1, m2");
    await user.click(screen.getByRole("button", { name: "Save allowlist" }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PUT" && c.path === "/api/admin/settings/models");
      expect(call).toBeTruthy();
      expect(JSON.parse(call?.body ?? "{}").models).toEqual(["m1", "m2"]);
    });
  });
});
