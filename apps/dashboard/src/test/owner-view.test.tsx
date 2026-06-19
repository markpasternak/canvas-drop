import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { persistOwnerView, readStoredOwnerView, resolveOwnerView } from "../lib/owner-view.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

const VIEW_KEY = "canvas-drop:owner-view";

/** A canvas-list row as the API serializes it (mirrors the your-canvases tests). */
function canvas(over: Record<string, unknown> = {}) {
  return {
    id: "alpha",
    slug: "alpha",
    url: "http://x/c/alpha",
    title: "Alpha canvas",
    description: null,
    shared: false,
    sharedExpiresAt: null,
    hasPassword: false,
    spaFallback: false,
    previewMode: "auto",
    galleryListed: false,
    galleryTemplatable: false,
    gallerySummary: null,
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

function summaryFor(canvases: Array<ReturnType<typeof canvas>>) {
  const active = canvases.filter((c) => c.status !== "archived" && c.status !== "deleted");
  return {
    active: active.length,
    archived: 0,
    shared: 0,
    protected: 0,
    listed: 0,
    templates: 0,
    neverDeployed: 0,
  };
}

function stub(all: Array<ReturnType<typeof canvas>>) {
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
          isAdmin: false,
          authMode: "dev",
        });
      }
      const sp = u.searchParams;
      const matched = all.filter((c) => c.status !== "archived" && c.status !== "deleted");
      const limit = Number(sp.get("limit") ?? 48);
      const offset = Number(sp.get("offset") ?? 0);
      return json({
        canvases: matched.slice(offset, offset + limit),
        total: matched.length,
        limit,
        offset,
        summary: summaryFor(all),
      });
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
  return router;
}

/** The grid view renders a `ul` whose className carries the grid layout classes;
 *  the list view renders a flat-list column header instead. Reading the resolved
 *  layout off the FIRST committed DOM (no intermediate effect) proves there is no
 *  wrong-layout flash. */
function isGridRendered(): boolean {
  return document.querySelector("ul.grid") !== null;
}
function isListRendered(): boolean {
  return (
    screen.queryByRole("checkbox", { name: "Select all canvases on this page" }) !== null &&
    document.querySelector("ul.grid") === null
  );
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* defensive */
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* defensive */
  }
});

describe("resolveOwnerView — precedence URL > localStorage > default(grid)", () => {
  it("no stored pref + no URL param → grid", () => {
    expect(readStoredOwnerView()).toBeNull();
    expect(resolveOwnerView(undefined)).toBe("grid");
  });

  it("stored 'list' + no URL param → list", () => {
    persistOwnerView("list");
    expect(readStoredOwnerView()).toBe("list");
    expect(resolveOwnerView(undefined)).toBe("list");
  });

  it("URL ?view=grid wins over a stored 'list'", () => {
    persistOwnerView("list");
    expect(resolveOwnerView("grid")).toBe("grid");
  });

  it("URL ?view=list wins over a stored 'grid'", () => {
    persistOwnerView("grid");
    expect(resolveOwnerView("list")).toBe("list");
  });

  it("ignores a junk URL value and falls back to the stored/default layer", () => {
    expect(resolveOwnerView("nonsense")).toBe("grid");
    persistOwnerView("list");
    expect(resolveOwnerView("nonsense")).toBe("list");
  });
});

describe("Owner list — default view + persisted preference (U8)", () => {
  it("first visit (no stored pref, no param) renders grid on first paint — no flash", async () => {
    stub([canvas()]);
    renderAt("/");
    // Wait on the unambiguous title link the grid card renders, then assert the
    // committed layout is grid (not list) — the very first render, not a later effect.
    await screen.findByRole("link", { name: "View details for Alpha canvas" });
    expect(isGridRendered()).toBe(true);
    expect(document.querySelector("ul.grid")).not.toBeNull();
  });

  it("a stored 'list' preference renders list with no URL param", async () => {
    localStorage.setItem(VIEW_KEY, "list");
    stub([canvas()]);
    renderAt("/");
    await screen.findByText("Alpha canvas");
    expect(isListRendered()).toBe(true);
  });

  it("?view=grid in the URL wins over a stored 'list' preference", async () => {
    localStorage.setItem(VIEW_KEY, "list");
    stub([canvas()]);
    renderAt("/?view=grid");
    await screen.findByRole("link", { name: "View details for Alpha canvas" });
    expect(isGridRendered()).toBe(true);
  });

  it("an explicit toggle to list persists and a re-render (no param) stays list", async () => {
    stub([canvas()]);
    // First mount: default grid (no stored pref).
    const router = renderAt("/");
    await screen.findByRole("link", { name: "View details for Alpha canvas" });
    expect(isGridRendered()).toBe(true);

    // Flip to list via the layout SegmentedControl.
    await userEvent.click(screen.getByRole("button", { name: "List view" }));
    // The choice is persisted per-device.
    expect(readStoredOwnerView()).toBe("list");

    // Re-render from a clean route WITHOUT a ?view= param: the stored choice now
    // resolves to list on first paint (persistence, not a flash back to grid).
    router.navigate({ to: "/", search: {} });
    await screen.findByRole("checkbox", { name: "Select all canvases on this page" });
    expect(isListRendered()).toBe(true);
  });
});
