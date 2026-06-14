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
  totalViews: 3120,
  uniqueViewers: 48,
  totalDeploys: 27,
  newCanvases: 5,
  newUsers: 2,
  recentWindowDays: 7,
  oldestDeletedAt: Date.now() - 12 * 86400000,
  topCanvases: [{ canvasId: "c1", ops: 1280, slug: "happy-otter", title: "Happy Otter" }],
  aiCostUsd: 1.5,
  aiTokens: 5120,
  aiCalls: 12,
};

const AI_USAGE = {
  byCanvas: [
    {
      canvasId: "c1",
      slug: "happy-otter",
      title: "Happy Otter",
      ownerEmail: "alice@example.com",
      costUsd: 4.0,
      calls: 9,
    },
  ],
};

const USER_ROW = {
  id: "u1",
  email: "alice@example.com",
  name: "Alice",
  avatarUrl: null,
  isAdmin: false,
  isBlocked: false,
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  canvasCount: 1,
};

const ADMIN_ME = {
  id: "admin",
  email: "admin@example.com",
  name: "Admin",
  avatarUrl: null,
  isAdmin: true,
};

/** A canvas page in the offset-pagination shape (plan 006). */
function canvasPage(rows: unknown[], total = rows.length): Response {
  return json({ canvases: rows, total, limit: 50, offset: 0 });
}

afterEach(() => {
  vi.restoreAllMocks();
  // CollapsibleSection persists open/closed state — reset so tests don't leak it.
  localStorage.clear();
});

describe("admin dashboard", () => {
  it("shows the Admin nav link only when me.isAdmin", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/ai-usage": () => json({ byUser: [], byCanvas: [] }),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
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
      "GET /api/canvases?limit=24&offset=0": () =>
        json({ canvases: [], total: 0, limit: 24, offset: 0 }),
      "GET /api/canvases/archived": () => json({ canvases: [] }),
    });
    renderAt("/");
    await waitFor(() => expect(calls.some((c) => c.path === "/api/me")).toBe(true));
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("renders overview stats and the admin workspace tabs", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/ai-usage": () => json({ byUser: [], byCanvas: [] }),
    });
    renderAt("/admin");
    expect(await screen.findByText("Total views")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument(); // user count
    // New engagement/activity cards.
    expect(screen.getByText("3,120")).toBeInTheDocument();
    expect(screen.getByText("Unique viewers")).toBeInTheDocument();
    expect(screen.getByText("Deploys")).toBeInTheDocument();
    expect(screen.getByText("27")).toBeInTheDocument(); // deploys
    expect(screen.getByRole("link", { name: /Happy Otter/ })).toHaveAttribute(
      "href",
      "/canvases/c1",
    );
    const adminNav = screen.getByRole("navigation", { name: "Admin sections" });
    expect(within(adminNav).getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(adminNav).getByRole("link", { name: "Canvases" })).toBeInTheDocument();
    expect(within(adminNav).getByRole("link", { name: "Users" })).toBeInTheDocument();
    expect(within(adminNav).getByRole("link", { name: "Configuration" })).toBeInTheDocument();
  });

  it("renders the all-canvases table on the Canvases tab", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
    });
    renderAt("/admin/canvases");
    expect(await screen.findByRole("heading", { name: "Canvases" })).toBeInTheDocument();
    expect(await screen.findByText("Happy Otter")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "alice@example.com" })).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument(); // row size
  });

  it("redirects old filtered /admin links to the Canvases tab with filters preserved", async () => {
    mockFetch({
      "GET /api/me": () => json(ADMIN_ME),
      "GET /api/admin/canvases?owner=u1&limit=50&offset=0": () => canvasPage([ROW]),
    });
    renderAt("/admin?owner=u1&page=1");
    expect(await screen.findByRole("heading", { name: "Canvases" })).toBeInTheDocument();
    expect(await screen.findByText(/Showing canvases owned by/)).toBeInTheDocument();
    expect(screen.getAllByText("alice@example.com").length).toBeGreaterThanOrEqual(1);
    expect(calls.some((c) => c.path === "/api/admin/canvases?owner=u1&limit=50&offset=0")).toBe(
      true,
    );
  });

  it("links a user's canvas count to that user's filtered Canvases tab", async () => {
    mockFetch({
      "GET /api/me": () => json(ADMIN_ME),
      "GET /api/admin/users": () => json({ users: [USER_ROW], total: 1, limit: 50, offset: 0 }),
      "GET /api/admin/canvases?owner=u1&limit=50&offset=0": () => canvasPage([ROW]),
    });
    renderAt("/admin/users");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "View canvases owned by alice@example.com" }),
    );
    expect(await screen.findByRole("heading", { name: "Canvases" })).toBeInTheDocument();
    expect(await screen.findByText(/Showing canvases owned by/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/admin/canvases?owner=u1&limit=50&offset=0")).toBe(
      true,
    );
  });

  it("filters the Canvases table by owner when an owner email is clicked", async () => {
    mockFetch({
      "GET /api/me": () => json(ADMIN_ME),
      "GET /api/admin/canvases?owner=u1&limit=50&offset=0": () => canvasPage([ROW]),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
    });
    renderAt("/admin/canvases");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "alice@example.com" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/admin/canvases?owner=u1&limit=50&offset=0")).toBe(
        true,
      ),
    );
    expect(await screen.findByText(/Showing canvases owned by/)).toBeInTheDocument();
  });

  it("collapses the platform overview and remembers it", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/ai-usage": () => json({ byUser: [], byCanvas: [] }),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
    });
    const first = renderAt("/admin");
    const user = userEvent.setup();
    // Wait for the overview data to render, then collapse it.
    expect(await screen.findByText("Total views")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Platform overview/i }));
    // Collapsed content stays in the DOM (so aria-controls resolves) but hidden.
    expect(screen.getByText("Total views")).not.toBeVisible();
    first.unmount();

    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/ai-usage": () => json({ byUser: [], byCanvas: [] }),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
    });
    renderAt("/admin");
    // The overview content stayed collapsed via localStorage.
    await screen.findByRole("button", { name: /Platform overview/i });
    expect(await screen.findByText("Total views")).not.toBeVisible();
  });

  it("renders the AI spend tile and the by-canvas breakdown — no per-user spend (plan 006)", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/ai-usage": () => json(AI_USAGE),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
    });
    renderAt("/admin");
    const user = userEvent.setup();
    // The AI spend tile lives in the always-visible stat strip.
    expect(await screen.findByText("AI spend")).toBeInTheDocument();
    expect(screen.getByText("$1.50")).toBeInTheDocument(); // platform spend
    // The breakdown sits in a section collapsed by default. There is NO by-user panel.
    expect(await screen.findByText("AI spend by canvas")).not.toBeVisible();
    expect(screen.queryByText("AI spend by user")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /AI usage/i }));
    expect(await screen.findByText("AI spend by canvas")).toBeVisible();
    expect(screen.getByText("$4.00")).toBeInTheDocument();
    // Spend is attributed to the canvas's owner (object fact).
    expect(screen.getAllByText("alice@example.com").length).toBeGreaterThanOrEqual(1);
  });

  it("remembers a collapsed section across remounts via localStorage", async () => {
    const handlers = {
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/ai-usage": () => json(AI_USAGE),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
    };
    mockFetch(handlers);
    const first = renderAt("/admin");
    const user = userEvent.setup();
    // "Top canvases by usage" is open by default; collapse it.
    const toggle = await screen.findByRole("button", { name: /Top canvases by usage/i });
    expect(screen.getByText("1,280 ops")).toBeVisible();
    await user.click(toggle);
    expect(screen.getByText("1,280 ops")).not.toBeVisible();
    first.unmount();

    // Remount: the collapsed state was persisted, so the list stays hidden.
    mockFetch(handlers);
    renderAt("/admin");
    await screen.findByRole("button", { name: /Top canvases by usage/i });
    expect(await screen.findByText("1,280 ops")).not.toBeVisible();
  });

  it("paginates with Previous/Next (offset) and shows the X–Y of N range", async () => {
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
      // total=60 so a second page exists (50/page); page 2 is fetched at offset=50.
      "GET /api/admin/canvases?limit=50&offset=50": () => canvasPage([page2], 60),
      "GET /api/admin/canvases": () => canvasPage([ROW], 60),
    });
    renderAt("/admin/canvases");
    const user = userEvent.setup();
    expect(await screen.findByText("Happy Otter")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–1 of 60")).toBeInTheDocument();
    // Page 2 not loaded yet; Previous is disabled on page 1.
    expect(screen.queryByText("Brave Lynx")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Brave Lynx")).toBeInTheDocument();
    // Page 1's row is no longer shown (offset pages replace, not append).
    await waitFor(() => expect(screen.queryByText("Happy Otter")).not.toBeInTheDocument());
  });

  it("switching the status filter resets to page 1 with a fresh query", async () => {
    const activeRow = { ...ROW, id: "a1", slug: "lone-active", title: "Lone Active" };
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/canvases?status=active&limit=50&offset=0": () => canvasPage([activeRow]),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
    });
    renderAt("/admin/canvases");
    const user = userEvent.setup();
    expect(await screen.findByText("Happy Otter")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Active" }));
    // New query (status=active) → only the active row shows.
    expect(await screen.findByText("Lone Active")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Happy Otter")).not.toBeInTheDocument());
  });

  it("overview failure shows a retry instead of silently vanishing", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json({ error: "boom" }, 500),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
    });
    renderAt("/admin");
    expect(await screen.findByText("Couldn't load the overview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
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
      "GET /api/admin/canvases?status=deleted&limit=50&offset=0": () => canvasPage([deleted]),
      "GET /api/admin/canvases": () => canvasPage([]),
    });
    renderAt("/admin/canvases");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deleted" }));
    expect(await screen.findByText(/Deleted 5d ago · awaiting purge/)).toBeInTheDocument();
  });

  it("takedown flow: opens the reason dialog, then POSTs disable with the reason", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/ai-usage": () => json({ byUser: [], byCanvas: [] }),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
      "POST /api/admin/canvases/c1/disable": () => json({ ok: true }),
    });
    renderAt("/admin/canvases");
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
      "GET /api/admin/ai-usage": () => json({ byUser: [], byCanvas: [] }),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
    });
    renderAt("/admin/canvases");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disable" }));
    const reason = (await screen.findByLabelText("Reason")) as HTMLTextAreaElement;
    await user.click(reason);
    await user.paste("x".repeat(600));
    // onChange slices to the server's 500 cap; the counter reflects the capped length.
    expect(reason.value.length).toBe(500);
    expect(screen.getByText("500/500")).toBeInTheDocument();
  });

  it("searches: typing filters the list via a debounced q param", async () => {
    const match = { ...ROW, id: "c7", slug: "weather-map", title: "Weather Map" };
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/canvases?q=weather&limit=50&offset=0": () => canvasPage([match]),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
    });
    renderAt("/admin/canvases");
    const user = userEvent.setup();
    expect(await screen.findByText("Happy Otter")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: /search all canvases/i }), "weather");
    expect(await screen.findByText("Weather Map")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Happy Otter")).not.toBeInTheDocument());
  });

  it("surfaces an audit-log placeholder (recorded, browser not yet built)", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/overview": () => json(OVERVIEW),
      "GET /api/admin/ai-usage": () => json({ byCanvas: [] }),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
    });
    renderAt("/admin");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Audit log/i }));
    expect(await screen.findByText("Audit log — coming soon")).toBeVisible();
  });

  it("Configuration view edits the model allowlist via the unified config endpoint", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/config": () =>
        json({
          fields: [
            {
              key: "ai.models",
              env: "CANVAS_DROP_AI_MODELS",
              group: "AI",
              label: "Model allowlist",
              type: "csv",
              secret: false,
              editable: true,
              source: "environment",
              overridden: false,
              value: "claude-fast",
            },
          ],
        }),
      "PUT /api/admin/config/ai.models": () => json({ ok: true }),
    });
    renderAt("/admin/settings");
    const user = userEvent.setup();
    const adminNav = await screen.findByRole("navigation", { name: "Admin sections" });
    expect(within(adminNav).getByRole("link", { name: "Configuration" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("link", { name: /back to admin/i })).not.toBeInTheDocument();
    const field = await screen.findByLabelText("Model allowlist");
    await user.clear(field);
    await user.type(field, "m1, m2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const call = calls.find(
        (c) => c.method === "PUT" && c.path === "/api/admin/config/ai.models",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call?.body ?? "{}").value).toEqual(["m1", "m2"]);
    });
  });

  it("Configuration view sets the AI provider key (write-only secret) via config", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/config": () =>
        json({
          fields: [
            {
              key: "ai.apiKey",
              env: "CANVAS_DROP_AI_API_KEY",
              group: "AI",
              label: "Provider API key",
              type: "string",
              secret: true,
              editable: true,
              source: "default",
              overridden: false,
              set: false,
            },
          ],
        }),
      "PUT /api/admin/config/ai.apiKey": () => json({ ok: true }),
    });
    renderAt("/admin/settings");
    const user = userEvent.setup();
    const field = (await screen.findByLabelText("Provider API key")) as HTMLInputElement;
    expect(field.type).toBe("password"); // never shown as plain text
    await user.type(field, "sk-ant-secret-1234");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const call = calls.find(
        (c) => c.method === "PUT" && c.path === "/api/admin/config/ai.apiKey",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call?.body ?? "{}").value).toBe("sk-ant-secret-1234");
    });
  });
});
