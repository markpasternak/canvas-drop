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
  deletedAt: null,
};

const OVERVIEW = {
  canvasCountByStatus: { active: 3, disabled: 1, archived: 2, deleted: 4 },
  userCount: 7,
  totalFileBytes: 4096,
  totalOps: 9001,
  newCanvases: 5,
  newUsers: 2,
  recentWindowDays: 7,
  oldestDeletedAt: Date.now() - 12 * 86400000,
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

  it("paginates: loads the next keyset page on 'Load more', then hides the button", async () => {
    const page2 = {
      ...ROW,
      id: "c2",
      slug: "brave-lynx",
      title: "Brave Lynx",
      owner: { id: "u2", email: "bob@example.com", name: "Bob" },
    };
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      // First page advertises a cursor; the second (fetched with ?cursor=cur1) ends it.
      "GET /api/admin/canvases": () => json({ canvases: [ROW], nextCursor: "cur1" }),
      "GET /api/admin/canvases?cursor=cur1": () => json({ canvases: [page2], nextCursor: null }),
    });
    renderAt("/admin");
    const user = userEvent.setup();
    expect(await screen.findByText("Happy Otter")).toBeInTheDocument();
    // Page 2 not loaded yet.
    expect(screen.queryByText("Brave Lynx")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Brave Lynx")).toBeInTheDocument();
    // Both rows present; cursor exhausted → no more "Load more".
    expect(screen.getByText("Happy Otter")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument(),
    );
  });

  it("overview failure shows a retry instead of silently vanishing", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json({ error: "boom" }, 500),
      "GET /api/admin/canvases": () => json({ canvases: [ROW], nextCursor: null }),
    });
    renderAt("/admin");
    expect(await screen.findByText("Couldn't load the overview")).toBeInTheDocument();
    // The canvas table below still renders independently.
    expect(await screen.findByText("Happy Otter")).toBeInTheDocument();
  });

  it("deleted rows show the purge-age hint (days since deletion)", async () => {
    const deleted = {
      ...ROW,
      id: "c9",
      slug: "old-canvas",
      title: "Old Canvas",
      status: "deleted",
      deletedAt: Date.now() - 5 * 86400000,
    };
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/canvases?status=deleted": () =>
        json({ canvases: [deleted], nextCursor: null }),
      "GET /api/admin/canvases": () => json({ canvases: [], nextCursor: null }),
    });
    renderAt("/admin");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deleted" }));
    expect(await screen.findByText(/Deleted 5d ago · awaiting purge/)).toBeInTheDocument();
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

  it("caps the takedown reason at 500 chars with a live counter", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/canvases": () => json({ canvases: [ROW], nextCursor: null }),
    });
    renderAt("/admin");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disable" }));
    const reason = (await screen.findByLabelText("Reason")) as HTMLTextAreaElement;
    await user.click(reason);
    await user.paste("x".repeat(600));
    // onChange slices to the server's 500 cap; the counter reflects the capped length.
    expect(reason.value.length).toBe(500);
    expect(screen.getByText("500/500")).toBeInTheDocument();
  });

  it("dedupes rows that overlap across keyset pages (no duplicate React keys)", async () => {
    // page 2 (stale cursor after a concurrent shift) repeats ROW from page 1.
    const other = { ...ROW, id: "c2", slug: "brave-lynx", title: "Brave Lynx" };
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/canvases": () => json({ canvases: [ROW], nextCursor: "cur1" }),
      "GET /api/admin/canvases?cursor=cur1": () =>
        json({ canvases: [ROW, other], nextCursor: null }),
    });
    renderAt("/admin");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Brave Lynx")).toBeInTheDocument();
    // ROW ("Happy Otter") was returned by both pages but must render exactly once.
    expect(screen.getAllByText("Happy Otter")).toHaveLength(1);
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
