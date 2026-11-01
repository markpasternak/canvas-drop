import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, fuzzyMatch } from "../components/CommandPalette.js";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";

/** A canvas-list row as the API serializes it. */
function canvas(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    slug: "s1",
    url: "http://x/c/s1",
    title: "Alpha canvas",
    description: null,
    shared: false,
    sharedExpiresAt: null,
    hasPassword: false,
    spaFallback: false,
    previewMode: "auto",
    galleryListed: false,
    galleryTemplatable: false,
    tags: null,
    status: "active",
    publicationState: "published",
    disabledReason: null,
    currentVersionId: "v1",
    createdAt: 0,
    updatedAt: 0,
    lastDeploy: { version: 1, createdAt: 0, fileCount: 1, totalBytes: 10 },
    ...over,
  };
}

function stub(
  opts: { isAdmin?: boolean; canvases?: Array<ReturnType<typeof canvas>>; failure?: boolean } = {},
) {
  const all = opts.canvases ?? [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url, "http://localhost");
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (u.pathname === "/api/me") {
        return json({
          id: "u1",
          email: "u@x",
          name: "U",
          avatarUrl: null,
          isAdmin: opts.isAdmin ?? false,
          authMode: "dev",
        });
      }
      if (opts.failure)
        return new Response(JSON.stringify({ code: "TEMPORARY", message: "Unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      const q = u.searchParams.get("q")?.toLowerCase() ?? "";
      const matched = all.filter((item) =>
        `${item.title} ${item.description ?? ""} ${item.slug}`.toLowerCase().includes(q),
      );
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const limit = Number(u.searchParams.get("limit") ?? 24);
      return json({
        canvases: matched.slice(offset, offset + limit),
        total: matched.length,
        limit,
        offset,
        summary: {
          active: all.length,
          archived: 0,
          shared: 0,
          protected: 0,
          listed: 0,
          templates: 0,
          neverDeployed: 0,
        },
      });
    }),
  );
}

/**
 * Render the palette in isolation over a minimal router that carries the same
 * destination paths the palette navigates to. This keeps the test off the full
 * dashboard route tree (no lazy chunks, no AppLayout), so navigation resolves
 * deterministically and there's no cross-test accumulation.
 */
function renderPalette() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <CommandPalette />
        <Outlet />
      </>
    ),
  });
  const leaf = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
  const routeTree = rootRoute.addChildren([
    leaf("/"),
    leaf("/gallery"),
    leaf("/shared"),
    leaf("/teams"),
    leaf("/admin"),
    leaf("/new"),
    leaf("/canvases/$id"),
  ]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
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
  return router;
}

async function openPalette() {
  await userEvent.keyboard("{Meta>}k{/Meta}");
  return screen.findByRole("combobox");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
});

describe("fuzzyMatch", () => {
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyMatch("Go to Gallery", "gal")).toBe(true);
    expect(fuzzyMatch("Go to Gallery", "GG")).toBe(true); // subsequence
    expect(fuzzyMatch("Go to Gallery", "")).toBe(true);
    expect(fuzzyMatch("Go to Gallery", "xyz")).toBe(false);
  });
});

describe("CommandPalette", () => {
  it("⌘K opens the palette; Escape closes it", async () => {
    stub();
    renderPalette();
    expect(screen.queryByRole("combobox")).toBeNull();
    await openPalette();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  });

  it("Ctrl-K also opens it", async () => {
    stub();
    renderPalette();
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
  });

  it("typing fuzzy-filters the command list", async () => {
    stub();
    renderPalette();
    const input = await openPalette();
    await userEvent.type(input, "gallery");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Go to Gallery");
  });

  it("shows the empty state when nothing matches", async () => {
    stub();
    renderPalette();
    const input = await openPalette();
    await userEvent.type(input, "zzzzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(await screen.findByText(/No matching commands/i)).toBeInTheDocument();
  });

  it("ArrowDown/ArrowUp move the highlight; Enter runs the highlighted command", async () => {
    stub();
    renderPalette();
    const input = await openPalette();
    // The three theme commands — a stable, non-navigating set to drive arrow keys over.
    await userEvent.type(input, "theme");
    const before = screen.getAllByRole("option");
    expect(before.length).toBeGreaterThanOrEqual(3);
    expect(before[0]).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");

    // Enter runs the highlighted command (first "theme" match → light) and closes.
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  });

  it("toggle-theme command applies the choice", async () => {
    stub();
    renderPalette();
    const input = await openPalette();
    await userEvent.type(input, "dark theme");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
  });

  it("hides the Admin command for non-admins", async () => {
    stub({ isAdmin: false });
    renderPalette();
    const input = await openPalette();
    await userEvent.type(input, "admin");
    expect(screen.queryByText("Go to Admin")).toBeNull();
  });

  it("shows the Admin command for admins", async () => {
    stub({ isAdmin: true });
    renderPalette();
    const input = await openPalette();
    await userEvent.type(input, "admin");
    expect(await screen.findByText("Go to Admin")).toBeInTheDocument();
  });

  it("Enter on a navigation command routes and closes the palette", async () => {
    stub();
    const router = renderPalette();
    const input = await openPalette();
    await userEvent.type(input, "go to gallery");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/gallery"));
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  });

  it("jump-to-canvas lists owned canvases by title and navigates on select", async () => {
    stub({ canvases: [canvas({ id: "jump1", title: "Reporting dashboard" })] });
    const router = renderPalette();
    const input = await openPalette();
    await userEvent.type(input, "Reporting");
    const option = await screen.findByRole("option", { name: /Reporting dashboard/ });
    await userEvent.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe("/canvases/jump1"));
  });
  it("finds a canvas beyond the first library page through server search, including description matches", async () => {
    stub({
      canvases: [
        ...Array.from({ length: 55 }, (_, index) =>
          canvas({ id: `c-${index}`, title: `Canvas ${index}` }),
        ),
        canvas({ id: "later", title: "Planning report", description: "Quarterly budget" }),
      ],
    });
    renderPalette();
    const input = await openPalette();
    await userEvent.type(input, "budget");
    expect(await screen.findByRole("option", { name: /Planning report/ })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("q=budget"))).toBe(
      true,
    );
  });

  it("loads subsequent matching pages and includes Shared and Teams commands", async () => {
    stub({
      canvases: Array.from({ length: 26 }, (_, index) =>
        canvas({ id: `c-${index}`, title: `Budget ${index}` }),
      ),
    });
    renderPalette();
    const input = await openPalette();
    expect(screen.getByRole("option", { name: "Go to Shared" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Go to Teams" })).toBeInTheDocument();
    await userEvent.type(input, "budget");
    const more = await screen.findByRole("button", { name: "Load more canvases" });
    expect(screen.queryByRole("option", { name: /Budget 25/ })).toBeNull();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close command search" })).toHaveFocus();
    await userEvent.tab();
    expect(more).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("option", { name: /Budget 25/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more canvases" })).toBeNull();
  });

  it("distinguishes a failed search from an empty result and retries", async () => {
    const options = { failure: true };
    stub(options);
    renderPalette();
    const input = await openPalette();
    await userEvent.type(input, "budget");
    const retry = await screen.findByRole("button", { name: "Retry canvas search" });
    expect(screen.queryByText(/No matching commands/)).toBeNull();
    options.failure = false;
    await userEvent.click(retry);
    expect(await screen.findByText(/No matching commands or canvases/)).toBeInTheDocument();
  });
});
