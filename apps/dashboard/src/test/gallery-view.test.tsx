import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import type { GalleryItem, GalleryPage } from "../lib/api.js";
import {
  persistGalleryView,
  readStoredGalleryView,
  resolveGalleryView,
} from "../lib/gallery-view.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

const VIEW_KEY = "canvas-drop:gallery-view";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function item(over: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id: "c1",
    slug: "s1",
    url: "http://x/c/s1",
    title: "Budget chart",
    description: "A handy budget chart",
    tags: ["charts"],
    templatable: true,
    publishedAt: 1,
    galleryFeatured: false,
    recentViews: 0,
    hasPreview: false,
    owner: { id: "u-alice", name: "alice", avatarUrl: null },
    ...over,
  };
}

const page = (items: GalleryItem[], over: Partial<GalleryPage> = {}): GalleryPage => ({
  items,
  total: items.length,
  limit: 48,
  offset: 0,
  ...over,
});

function stubGallery(items: GalleryItem[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url, "http://localhost");
      if (u.pathname === "/api/gallery/facets") return json({ owners: [], tags: [] });
      if (u.pathname !== "/api/gallery") return json({ error: "not_mocked" }, 500);
      // The U17 discovery strips (Featured / Recently published) fire their own
      // `?featured=1` / `?sort=recent` requests. Resolve those to an empty page so the
      // main grid is the only place each item appears (these view-toggle tests assert
      // on a single "Alpha" link / the single `ul.grid`).
      const p = u.searchParams;
      if (p.get("featured") === "1" || p.get("sort") === "recent") return json(page([]));
      return json(page(items));
    }),
  );
}

function renderGallery(initial = "/gallery") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initial] }),
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

/** The grid renders a `ul.grid`; the list renders rows in a divided `ul` (no `.grid`). */
function isGrid(): boolean {
  return document.querySelector("ul.grid") !== null;
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

describe("resolveGalleryView — precedence URL > localStorage > default(grid)", () => {
  it("no stored pref + no URL param → grid", () => {
    expect(readStoredGalleryView()).toBeNull();
    expect(resolveGalleryView(undefined)).toBe("grid");
  });

  it("stored 'list' + no URL param → list", () => {
    persistGalleryView("list");
    expect(readStoredGalleryView()).toBe("list");
    expect(resolveGalleryView(undefined)).toBe("list");
  });

  it("URL ?view=grid wins over a stored 'list'", () => {
    persistGalleryView("list");
    expect(resolveGalleryView("grid")).toBe("grid");
  });

  it("ignores a junk URL value and falls back to the stored/default layer", () => {
    expect(resolveGalleryView("nonsense")).toBe("grid");
    persistGalleryView("list");
    expect(resolveGalleryView("nonsense")).toBe("list");
  });
});

describe("Gallery — grid/list toggle (persisted, URL-overridable)", () => {
  it("defaults to grid on first paint (no stored pref, no param)", async () => {
    stubGallery([item({ title: "Alpha" })]);
    renderGallery();
    await screen.findByRole("link", { name: "Alpha" });
    expect(isGrid()).toBe(true);
  });

  it("a stored 'list' preference renders list (no param)", async () => {
    localStorage.setItem(VIEW_KEY, "list");
    stubGallery([item({ title: "Alpha" })]);
    renderGallery();
    await screen.findByRole("link", { name: "Alpha" });
    expect(isGrid()).toBe(false);
  });

  it("?view=list in the URL wins over a stored 'grid'", async () => {
    localStorage.setItem(VIEW_KEY, "grid");
    stubGallery([item({ title: "Alpha" })]);
    renderGallery("/gallery?view=list");
    await screen.findByRole("link", { name: "Alpha" });
    expect(isGrid()).toBe(false);
  });

  it("an explicit toggle to list persists the per-device choice", async () => {
    stubGallery([item({ title: "Alpha" })]);
    renderGallery();
    await screen.findByRole("link", { name: "Alpha" });
    expect(isGrid()).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "List view" }));
    expect(readStoredGalleryView()).toBe("list");
    expect(isGrid()).toBe(false);
  });

  it("the shared list row (gallery) surfaces the template affordance", async () => {
    stubGallery([item({ title: "Alpha", templatable: true })]);
    renderGallery("/gallery?view=list");
    await screen.findByRole("link", { name: "Alpha" });
    expect(isGrid()).toBe(false);
    // The only gallery-specific differentiator: the Use-template action on the row.
    expect(screen.getByRole("button", { name: "Use template" })).toBeInTheDocument();
  });
});
