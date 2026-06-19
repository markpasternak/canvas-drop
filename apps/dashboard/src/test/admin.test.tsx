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
  access: "private",
  publicationState: "published",
  galleryListed: true,
  galleryFeatured: false,
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
  publicLinkCount: 2,
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

const CONFIG_FIELDS = [
  {
    key: "ai.models",
    env: "CANVAS_DROP_AI_MODELS",
    group: "AI",
    label: "Model allowlist",
    help: "Models canvases may call. Comma-separated plain IDs.",
    type: "csv",
    secret: false,
    editable: true,
    source: "environment",
    overridden: false,
    value: "claude-fast",
  },
  {
    key: "ai.apiKey",
    env: "CANVAS_DROP_AI_API_KEY",
    group: "AI",
    label: "Provider API key",
    help: "Server-side only. Used by the server to call the AI provider.",
    type: "string",
    secret: true,
    editable: true,
    source: "database",
    overridden: true,
    set: true,
    last4: "1234",
  },
  {
    key: "email.smtp.host",
    env: "CANVAS_DROP_SMTP_HOST",
    group: "Email",
    label: "SMTP host",
    help: "Outgoing mail server for guest invites.",
    type: "string",
    secret: false,
    editable: false,
    source: "default",
    overridden: false,
    value: "smtp.local",
  },
  {
    key: "auth.mode",
    env: "CANVAS_DROP_AUTH_MODE",
    group: "Auth",
    label: "Auth mode",
    type: "enum",
    secret: false,
    editable: false,
    source: "environment",
    overridden: false,
    value: "oidc",
  },
  {
    key: "storage.s3.secretKey",
    env: "CANVAS_DROP_S3_SECRET_KEY",
    group: "Storage",
    label: "S3 secret key",
    type: "string",
    secret: true,
    editable: false,
    source: "default",
    overridden: false,
    set: false,
  },
];

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
      "GET /api/admin/ai-usage": () => json({ byCanvas: [] }),
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
      "GET /api/admin/ai-usage": () => json({ byCanvas: [] }),
    });
    renderAt("/admin");
    expect(await screen.findByText("Total views")).toBeInTheDocument();
    // The page heading is "Administration" (the tab stays "Overview").
    expect(screen.getByRole("heading", { name: "Administration" })).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument(); // user count
    // New engagement/activity cards.
    expect(screen.getByText("3,120")).toBeInTheDocument();
    expect(screen.getByText("Unique viewers")).toBeInTheDocument();
    expect(screen.getByText("Deploys")).toBeInTheDocument();
    expect(screen.getByText("27")).toBeInTheDocument(); // deploys
    // "Happy Otter" appears in the Top-canvases section (and the attention lane).
    expect(screen.getAllByText("Happy Otter").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("happy-otter")).toBeInTheDocument();
    // No link opens another owner's canvas detail (admins 404 there). The
    // attention lane links to the filtered /admin/canvases table, never /canvases/$id.
    for (const link of screen.queryAllByRole("link")) {
      expect(link.getAttribute("href") ?? "").not.toMatch(/\/canvases\/[^/?]+$/);
    }
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
      "GET /api/admin/ai-usage": () => json({ byCanvas: [] }),
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
      "GET /api/admin/ai-usage": () => json({ byCanvas: [] }),
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
    // $4.00 shows in the AI-spend panel (and the attention lane's top-spender row).
    expect(screen.getAllByText("$4.00").length).toBeGreaterThanOrEqual(1);
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
    // "Top canvases by usage" is open by default; collapse it. "1,280 ops" also
    // appears in the always-visible attention lane, so scope to the ranked list item.
    const toggle = await screen.findByRole("button", { name: /Top canvases by usage/i });
    const opsInList = () =>
      screen.getAllByText("1,280 ops").find((el) => el.closest("li") !== null) as HTMLElement;
    expect(opsInList()).toBeVisible();
    await user.click(toggle);
    expect(opsInList()).not.toBeVisible();
    first.unmount();

    // Remount: the collapsed state was persisted, so the list stays hidden.
    mockFetch(handlers);
    renderAt("/admin");
    await screen.findByRole("button", { name: /Top canvases by usage/i });
    await waitFor(() => expect(opsInList()).not.toBeVisible());
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
      "GET /api/admin/ai-usage": () => json({ byCanvas: [] }),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
      "POST /api/admin/canvases/c1/disable": () => json({ ok: true }),
    });
    renderAt("/admin/canvases");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Actions for Happy Otter" }));
    await user.click(await screen.findByRole("menuitem", { name: "Disable" }));
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
      "GET /api/admin/ai-usage": () => json({ byCanvas: [] }),
      "GET /api/admin/canvases": () => canvasPage([ROW]),
    });
    renderAt("/admin/canvases");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Actions for Happy Otter" }));
    await user.click(await screen.findByRole("menuitem", { name: "Disable" }));
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

  it("Configuration finder searches labels, keys, env vars, groups, help, source, and values", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/config": () => json({ fields: CONFIG_FIELDS }),
    });
    renderAt("/admin/settings");
    const user = userEvent.setup();
    const search = await screen.findByRole("searchbox", {
      name: /search configuration settings/i,
    });

    const checks = [
      { term: "Provider", visible: "Provider API key", hidden: "SMTP host" },
      { term: "CANVAS_DROP_AI_MODELS", visible: "Model allowlist", hidden: "SMTP host" },
      { term: "Email", visible: "SMTP host", hidden: "Auth mode" },
      { term: "guest invites", visible: "SMTP host", hidden: "Model allowlist" },
      { term: "smtp.local", visible: "SMTP host", hidden: "Provider API key" },
      { term: "environment", visible: "Auth mode", hidden: "SMTP host" },
    ];

    for (const check of checks) {
      await user.clear(search);
      await user.type(search, check.term);
      expect(screen.getByText(check.visible)).toBeVisible();
      await waitFor(() => expect(screen.queryByText(check.hidden)).not.toBeInTheDocument());
    }
  });

  it("Configuration quick filters narrow editable, overridden, secret, and read-only rows", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/config": () => json({ fields: CONFIG_FIELDS }),
    });
    renderAt("/admin/settings");
    const user = userEvent.setup();
    expect(await screen.findByText("Model allowlist")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Editable" }));
    expect(screen.getByText("Model allowlist")).toBeVisible();
    expect(screen.getByText("Provider API key")).toBeVisible();
    expect(screen.queryByText("SMTP host")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Overridden" }));
    expect(screen.getByText("Provider API key")).toBeVisible();
    expect(screen.queryByText("Model allowlist")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Secrets" }));
    expect(screen.getByText("Provider API key")).toBeVisible();
    expect(screen.getByText("S3 secret key")).toBeVisible();
    expect(screen.queryByText("SMTP host")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Read-only" }));
    expect(screen.getByText("SMTP host")).toBeVisible();
    expect(screen.getByText("Auth mode")).toBeVisible();
    expect(screen.getByText("S3 secret key")).toBeVisible();
    expect(screen.queryByText("Provider API key")).not.toBeInTheDocument();
  });

  it("Configuration finder shows a clearable empty state", async () => {
    mockFetch({
      "GET /api/me": () =>
        json({ id: "u1", email: "a@x", name: "A", avatarUrl: null, isAdmin: true }),
      "GET /api/admin/config": () => json({ fields: CONFIG_FIELDS }),
    });
    renderAt("/admin/settings");
    const user = userEvent.setup();
    const search = (await screen.findByRole("searchbox", {
      name: /search configuration settings/i,
    })) as HTMLInputElement;

    await user.type(search, "not-a-setting");
    expect(await screen.findByText("No settings match")).toBeVisible();
    expect(screen.queryByText("Model allowlist")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(search).toHaveValue("");
    expect(await screen.findByText("Model allowlist")).toBeVisible();
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

  describe("needs-attention lane (U18)", () => {
    function overviewHandlers(overviewBody: unknown, aiBody: unknown = AI_USAGE) {
      return {
        "GET /api/me": () => json(ADMIN_ME),
        "GET /api/admin/overview": () => json(overviewBody),
        "GET /api/admin/ai-usage": () => json(aiBody),
        "GET /api/admin/canvases": () => canvasPage([ROW]),
        "GET /api/admin/canvases?access=public_link&limit=50&offset=0": () => canvasPage([ROW]),
        "GET /api/admin/canvases?status=deleted&limit=50&offset=0": () => canvasPage([]),
        "GET /api/admin/canvases?status=disabled&limit=50&offset=0": () => canvasPage([]),
      };
    }

    it("renders each derivable signal with its count (public links, purge, disabled, spend, usage)", async () => {
      mockFetch(overviewHandlers(OVERVIEW));
      renderAt("/admin");
      // Public-link exposure (publicLinkCount=2) — scope the count to its row.
      const publicRow = (await screen.findByText("Public-link canvases")).closest("a");
      expect(publicRow).not.toBeNull();
      expect(within(publicRow as HTMLElement).getByText("2")).toBeInTheDocument();
      // Purge backlog (deleted=4, oldest 12d ago).
      expect(screen.getByText("Awaiting purge")).toBeInTheDocument();
      expect(screen.getByText(/Oldest deleted 12d ago/)).toBeInTheDocument();
      // Disabled (1).
      expect(screen.getByText("Disabled canvases")).toBeInTheDocument();
      // Top AI spender ($4.00 from AI_USAGE).
      expect(screen.getByText("Top AI spender")).toBeInTheDocument();
      // Most active canvas (1,280 ops, from topCanvases).
      expect(screen.getByText("Most active canvas")).toBeInTheDocument();
    });

    it("links each signal to its filtered admin canvases view", async () => {
      mockFetch(overviewHandlers(OVERVIEW));
      renderAt("/admin");
      const publicRow = (await screen.findByText("Public-link canvases")).closest("a");
      expect(publicRow).toHaveAttribute("href", expect.stringContaining("access=public_link"));
      const purgeRow = screen.getByText("Awaiting purge").closest("a");
      expect(purgeRow).toHaveAttribute("href", expect.stringContaining("status=deleted"));
      const disabledRow = screen.getByText("Disabled canvases").closest("a");
      expect(disabledRow).toHaveAttribute("href", expect.stringContaining("status=disabled"));
    });

    it("clicking the public-link signal navigates to the access=public_link table view", async () => {
      mockFetch(overviewHandlers(OVERVIEW));
      renderAt("/admin");
      const user = userEvent.setup();
      await user.click(await screen.findByText("Public-link canvases"));
      await waitFor(() =>
        expect(
          calls.some((c) => c.path === "/api/admin/canvases?access=public_link&limit=50&offset=0"),
        ).toBe(true),
      );
    });

    it("hides individual signals with nothing to surface (no public links, no deleted, no disabled)", async () => {
      const clean = {
        ...OVERVIEW,
        canvasCountByStatus: { active: 5 },
        publicLinkCount: 0,
        oldestDeletedAt: null,
        topCanvases: [],
      };
      mockFetch(overviewHandlers(clean, { byCanvas: [] }));
      renderAt("/admin");
      expect(await screen.findByText("Total views")).toBeInTheDocument();
      // No signals → none of the signal rows render.
      expect(screen.queryByText("Public-link canvases")).not.toBeInTheDocument();
      expect(screen.queryByText("Awaiting purge")).not.toBeInTheDocument();
      expect(screen.queryByText("Disabled canvases")).not.toBeInTheDocument();
    });

    it("renders an all-clear state (lane stays visible) when nothing is flagged", async () => {
      const clean = {
        ...OVERVIEW,
        canvasCountByStatus: { active: 5 },
        publicLinkCount: 0,
        oldestDeletedAt: null,
        topCanvases: [],
      };
      mockFetch(overviewHandlers(clean, { byCanvas: [] }));
      renderAt("/admin");
      // The lane itself is ALWAYS shown — the section header + a calm all-clear message
      // explaining what it watches, never vanishing on a clean instance.
      expect(await screen.findByRole("button", { name: /Needs attention/i })).toBeInTheDocument();
      expect(screen.getByText("Nothing needs attention right now")).toBeInTheDocument();
      expect(screen.getByText(/public-link exposure/i)).toBeInTheDocument();
    });

    it("has no trend-delta or screenshot-failure UI", async () => {
      mockFetch(overviewHandlers(OVERVIEW));
      renderAt("/admin");
      await screen.findByText("Public-link canvases");
      expect(screen.queryByText(/week over week/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/screenshot/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/vs\.? last/i)).not.toBeInTheDocument();
    });

    it("renders the URGENT (amber) purge treatment when the oldest deleted canvas is >30 days old", async () => {
      // 31-day-old oldest-deleted crosses the PURGE_URGENT_DAYS=30 threshold, so the
      // "Awaiting purge" row reads as urgent (amber accent + warning-toned count),
      // not the routine info treatment.
      const urgentPurge = { ...OVERVIEW, oldestDeletedAt: Date.now() - 31 * 86400000 };
      mockFetch(overviewHandlers(urgentPurge));
      renderAt("/admin");

      const detail = await screen.findByText(/Oldest deleted 31d ago/);
      const row = detail.closest("a") as HTMLElement;
      // The whole row carries the amber urgent accent…
      expect(row.className).toMatch(/warning/);
      // …and the count is rendered in the warning tone (not the calm fg tone).
      const count = within(row).getByText("4");
      expect(count.className).toMatch(/text-warning/);
    });
  });

  describe("admin featured toggle (U18)", () => {
    it("featured rows show a Featured badge in the table", async () => {
      const featured = { ...ROW, galleryFeatured: true };
      mockFetch({
        "GET /api/me": () => json(ADMIN_ME),
        "GET /api/admin/canvases": () => canvasPage([featured]),
      });
      renderAt("/admin/canvases");
      expect(await screen.findByText("Happy Otter")).toBeInTheDocument();
      expect(screen.getByText("Featured")).toBeInTheDocument();
    });

    it("the Feature action POSTs galleryFeatured=true for an unfeatured canvas", async () => {
      mockFetch({
        "GET /api/me": () => json(ADMIN_ME),
        "GET /api/admin/canvases": () => canvasPage([ROW]),
        "POST /api/admin/canvases/c1/feature": () => json({ ok: true }),
      });
      renderAt("/admin/canvases");
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Actions for Happy Otter" }));
      await user.click(await screen.findByRole("menuitem", { name: "Feature in gallery" }));
      await waitFor(() => {
        const call = calls.find((c) => c.path === "/api/admin/canvases/c1/feature");
        expect(call).toBeTruthy();
        expect(JSON.parse(call?.body ?? "{}").featured).toBe(true);
      });
    });

    it("offers Feature only for a gallery-listed + published row", async () => {
      mockFetch({
        "GET /api/me": () => json(ADMIN_ME),
        "GET /api/admin/canvases": () => canvasPage([ROW]),
      });
      renderAt("/admin/canvases");
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Actions for Happy Otter" }));
      const item = await screen.findByRole("menuitem", { name: "Feature in gallery" });
      expect(item).toBeInTheDocument();
      expect(item).not.toHaveAttribute("aria-disabled", "true");
    });

    it("disables Feature for a NON-listed row with an explanatory hint", async () => {
      const notListed = { ...ROW, galleryListed: false };
      mockFetch({
        "GET /api/me": () => json(ADMIN_ME),
        "GET /api/admin/canvases": () => canvasPage([notListed]),
      });
      renderAt("/admin/canvases");
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Actions for Happy Otter" }));
      const item = await screen.findByRole("menuitem", { name: "Feature in gallery" });
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveAttribute("title", "Only gallery-listed canvases can be featured");
    });

    it("disables Feature for a listed-but-DRAFT (unpublished) row", async () => {
      const draft = { ...ROW, galleryListed: true, publicationState: "draft" as const };
      mockFetch({
        "GET /api/me": () => json(ADMIN_ME),
        "GET /api/admin/canvases": () => canvasPage([draft]),
      });
      renderAt("/admin/canvases");
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Actions for Happy Otter" }));
      const item = await screen.findByRole("menuitem", { name: "Feature in gallery" });
      expect(item).toHaveAttribute("aria-disabled", "true");
    });

    it("a featured row shows Unfeature (enabled) even when no longer gallery-listed", async () => {
      // Stale featured flag on a since-unlisted canvas → Unfeature must stay available.
      const featuredNotListed = { ...ROW, galleryListed: false, galleryFeatured: true };
      mockFetch({
        "GET /api/me": () => json(ADMIN_ME),
        "GET /api/admin/canvases": () => canvasPage([featuredNotListed]),
        "POST /api/admin/canvases/c1/feature": () => json({ ok: true }),
      });
      renderAt("/admin/canvases");
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Actions for Happy Otter" }));
      const item = await screen.findByRole("menuitem", { name: "Unfeature" });
      expect(item).not.toHaveAttribute("aria-disabled", "true");
    });

    it("a featured canvas shows Unfeature and POSTs galleryFeatured=false", async () => {
      const featured = { ...ROW, galleryFeatured: true };
      mockFetch({
        "GET /api/me": () => json(ADMIN_ME),
        "GET /api/admin/canvases": () => canvasPage([featured]),
        "POST /api/admin/canvases/c1/feature": () => json({ ok: true }),
      });
      renderAt("/admin/canvases");
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Actions for Happy Otter" }));
      await user.click(await screen.findByRole("menuitem", { name: "Unfeature" }));
      await waitFor(() => {
        const call = calls.find((c) => c.path === "/api/admin/canvases/c1/feature");
        expect(call).toBeTruthy();
        expect(JSON.parse(call?.body ?? "{}").featured).toBe(false);
      });
    });

    it("surfaces an error toast when the feature POST fails (doFeature catch)", async () => {
      mockFetch({
        "GET /api/me": () => json(ADMIN_ME),
        "GET /api/admin/canvases": () => canvasPage([ROW]),
        "POST /api/admin/canvases/c1/feature": () =>
          json({ message: "Could not feature this canvas." }, 500),
      });
      renderAt("/admin/canvases");
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Actions for Happy Otter" }));
      await user.click(await screen.findByRole("menuitem", { name: "Feature in gallery" }));
      // The doFeature catch surfaces the failure instead of leaving the click silent.
      expect(await screen.findByText(/could not feature this canvas/i)).toBeInTheDocument();
    });
  });
});
