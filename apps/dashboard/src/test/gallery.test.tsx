import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import type { GalleryItem, GalleryPage } from "../lib/api.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

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
    templatable: false,
    publishedAt: 1,
    galleryFeatured: false,
    recentViews: 0,
    hasPreview: false,
    owner: { id: "u-alice", name: "alice", avatarUrl: null },
    ...over,
  };
}

type Facets = {
  owners: Array<{ id: string; name: string; avatarUrl: string | null }>;
  tags: string[];
};

/** Is this gallery request one of the U17 discovery-strip slices (Featured /
 *  Recently published) rather than the main paginated browse? */
function isDiscoveryCall(p: URLSearchParams): boolean {
  return p.get("featured") === "1" || p.get("sort") === "recent";
}

/** Stub /api/gallery (browse) and /api/gallery/facets. `handler` receives the parsed
 *  browse query; `facets` seeds the owner/tag picker lists (plan 004).
 *
 *  The U17 discovery rows fire their own `?featured=1` / `?sort=recent` gallery
 *  requests. By default those resolve to an empty page (so existing main-grid
 *  assertions see exactly one copy of each item); pass `discovery` to opt a test
 *  into populated rows. The returned `calls` array records ALL gallery requests. */
function stubGallery(
  handler: (params: URLSearchParams) => GalleryPage | Response,
  facets: Facets = { owners: [], tags: [] },
  discovery?: (params: URLSearchParams) => GalleryPage | Response,
) {
  const calls: URLSearchParams[] = [];
  const fn = vi.fn(async (url: string) => {
    const u = new URL(url, "http://localhost");
    if (u.pathname === "/api/gallery/facets") return json(facets);
    if (u.pathname !== "/api/gallery") return json({ error: "not_mocked" }, 500);
    calls.push(u.searchParams);
    if (isDiscoveryCall(u.searchParams)) {
      const d = discovery ? discovery(u.searchParams) : page([]);
      return d instanceof Response ? d : json(d);
    }
    const out = handler(u.searchParams);
    return out instanceof Response ? out : json(out);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
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

const page = (items: GalleryItem[], over: Partial<GalleryPage> = {}): GalleryPage => ({
  items,
  total: items.length,
  limit: 30,
  offset: 0,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("Gallery view", () => {
  it("renders a card grid: title links externally, description, tags, owner", async () => {
    stubGallery(() => page([item({ title: "Budget chart", description: "Quarterly budget" })]));
    renderGallery();

    const title = await screen.findByRole("link", { name: "Budget chart" });
    expect(title).toHaveAttribute("href", "http://x/c/s1");
    expect(title).toHaveAttribute("target", "_blank");
    expect(screen.getByText("Quarterly budget")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("charts")).toBeInTheDocument();
  });

  it("shows a Template badge and a 'Make a copy' action only for templatable items", async () => {
    stubGallery(() => page([item({ id: "t1", templatable: true })]));
    renderGallery();
    // The content-aware fallback cover (U6) also marks the type, so "Template" can
    // appear on both the card badge and the decorative cover marker — assert the badge
    // exists (≥1) rather than a single match.
    expect((await screen.findAllByText("Template")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Use template" })).toBeInTheDocument();
  });

  it("hides the clone action for non-templatable items", async () => {
    stubGallery(() => page([item({ id: "n1", templatable: false })]));
    renderGallery();
    await screen.findByRole("link", { name: "Budget chart" });
    // A non-templatable gallery item carries no "Template" marker on badge or cover.
    expect(screen.queryByText("Template")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use template" })).not.toBeInTheDocument();
  });

  it("shows the no-canvases-yet empty state (no filters) with a link back", async () => {
    stubGallery(() => page([]));
    renderGallery();
    expect(await screen.findByText("No canvases in the gallery yet")).toBeInTheDocument();
    expect(screen.getByText("Back to your canvases")).toBeInTheDocument();
  });

  it("shows the no-results empty state when filtering, and Clear filters resets", async () => {
    const calls = stubGallery((p) => (p.get("q") ? page([]) : page([item()])));
    renderGallery("/gallery?q=zzz");

    expect(await screen.findByText("No gallery canvases match your filters")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    // After clearing, the query has no q and the full listing renders.
    await screen.findByRole("link", { name: "Budget chart" });
    expect(calls.some((c) => !c.get("q"))).toBe(true);
  });

  it("renders the error state with a retry control", async () => {
    stubGallery(() => json({ error: "boom" }, 500));
    renderGallery();
    expect(await screen.findByText("Couldn't load the gallery")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("debounces typing into `q`, and clearing the field applies immediately", async () => {
    const calls = stubGallery((p) => {
      const q = p.get("q");
      return page(q ? [item({ id: "match", title: q })] : [item({ title: "Everything" })]);
    });
    renderGallery();
    await screen.findByRole("link", { name: "Everything" });

    const box = screen.getByRole("searchbox", { name: "Search the gallery" });
    await userEvent.type(box, "revenue");
    await waitFor(() => expect(calls.some((c) => c.get("q") === "revenue")).toBe(true));

    await userEvent.clear(box);
    // Clearing returns to the unfiltered listing.
    await screen.findByRole("link", { name: "Everything" });
  });

  it("filters by a tag chip and clears it via the X affordance", async () => {
    const calls = stubGallery((p) =>
      page([item({ title: p.get("tag") ? "Filtered" : "All", tags: ["charts"] })]),
    );
    renderGallery();
    await screen.findByRole("link", { name: "All" });

    await userEvent.click(screen.getByRole("button", { name: "charts" }));
    await waitFor(() => expect(calls.some((c) => c.get("tag") === "charts")).toBe(true));

    await userEvent.click(await screen.findByRole("button", { name: "Remove tag filter" }));
    await waitFor(() => expect(calls.some((c) => !c.get("tag"))).toBe(true));
  });

  it("clicking a tag while a search is active preserves the search (merge, not replace)", async () => {
    const calls = stubGallery((p) =>
      page([item({ title: p.get("tag") ? "Filtered" : "All", tags: ["charts"] })]),
    );
    renderGallery("/gallery?q=budget");
    await screen.findByRole("link", { name: "All" });

    await userEvent.click(screen.getByRole("button", { name: "charts" }));
    // The tag-filtered request still carries the original q.
    await waitFor(() =>
      expect(calls.some((c) => c.get("tag") === "charts" && c.get("q") === "budget")).toBe(true),
    );
  });

  it("resets to page 1 (offset 0) when a filter changes while on a later page", async () => {
    const calls = stubGallery((p) =>
      page([item({ title: p.get("q") ? "Filtered" : "Page two" })], {
        total: 80,
        limit: 30,
        offset: Number(p.get("offset") ?? 0),
      }),
    );
    renderGallery("/gallery?page=2");
    await screen.findByRole("link", { name: "Page two" });
    expect(calls.some((c) => c.get("offset") === "30")).toBe(true);

    await userEvent.type(screen.getByRole("searchbox", { name: "Search the gallery" }), "revenue");
    // The search request goes out at offset 0, not the stale page-2 offset.
    await waitFor(() =>
      expect(calls.some((c) => c.get("q") === "revenue" && (c.get("offset") ?? "0") === "0")).toBe(
        true,
      ),
    );
  });

  it("paginates: derives range from the response and advances offset", async () => {
    const items = Array.from({ length: 30 }, (_, i) => item({ id: `c${i}`, title: `Canvas ${i}` }));
    const calls = stubGallery((p) => {
      const offset = Number(p.get("offset") ?? 0);
      return offset === 0
        ? page(items, { total: 60, limit: 30, offset: 0 })
        : page([item({ id: "x", title: "Last page item" })], { total: 60, limit: 30, offset: 30 });
    });
    renderGallery();

    await screen.findByRole("link", { name: "Canvas 0" });
    expect(screen.getByText("Showing 1–30 of 60")).toBeInTheDocument();
    const prev = screen.getByRole("button", { name: "Previous" });
    expect(prev).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(calls.some((c) => c.get("offset") === "30")).toBe(true));
    await screen.findByRole("link", { name: "Last page item" });
    expect(screen.getByText("Showing 31–31 of 60")).toBeInTheDocument();
  });

  it("snaps back to page 1 when the offset exceeds total after a refetch", async () => {
    const calls = stubGallery((p) => {
      const offset = Number(p.get("offset") ?? 0);
      // Page 2 requested but only 3 items exist now → out of range.
      return offset >= 30
        ? page([], { total: 3, limit: 30, offset })
        : page([item({ title: "Reset to first" })], { total: 3, limit: 30, offset: 0 });
    });
    renderGallery("/gallery?page=2");

    await screen.findByRole("link", { name: "Reset to first" });
    expect(calls.some((c) => (c.get("offset") ?? "0") === "0")).toBe(true);
  });

  it("filters by owner from the facet list (plan 004)", async () => {
    const calls = stubGallery(
      (p) => page([item({ title: p.get("owner") ? "Bob's canvas" : "All" })]),
      { owners: [{ id: "u-bob", name: "bob", avatarUrl: null }], tags: [] },
    );
    renderGallery();
    await screen.findByRole("link", { name: "All" });

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Filter by owner" }),
      "u-bob",
    );
    await waitFor(() => expect(calls.some((c) => c.get("owner") === "u-bob")).toBe(true));
  });

  it("toggles the templatable filter via the Templates chip (plan 004)", async () => {
    const calls = stubGallery((p) =>
      page([item({ title: p.get("templatable") ? "Only templates" : "All" })]),
    );
    renderGallery();
    await screen.findByRole("link", { name: "All" });

    await userEvent.click(screen.getByRole("button", { name: "Templates" }));
    await waitFor(() => expect(calls.some((c) => c.get("templatable") === "1")).toBe(true));
    // Toggling off drops the param.
    await userEvent.click(screen.getByRole("button", { name: "Templates" }));
    await waitFor(() => expect(calls.some((c) => !c.get("templatable"))).toBe(true));
  });

  it("changes the sort axis via the sort select (plan 004)", async () => {
    const calls = stubGallery(() => page([item()]));
    renderGallery();
    await screen.findByRole("link", { name: "Budget chart" });

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort canvases" }), "title");
    await waitFor(() => expect(calls.some((c) => c.get("sort") === "title")).toBe(true));
  });

  it("hydrates all filters from the URL (shareable, back-button-able) (plan 004)", async () => {
    const calls = stubGallery(() => page([item()]), {
      owners: [{ id: "u-bob", name: "bob", avatarUrl: null }],
      tags: ["charts"],
    });
    renderGallery("/gallery?owner=u-bob&templatable=true&sort=title&tag=charts");
    await screen.findByRole("link", { name: "Budget chart" });

    // The initial request carries every filter from the URL.
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.get("owner") === "u-bob" &&
            c.get("templatable") === "1" &&
            c.get("sort") === "title" &&
            c.get("tag") === "charts",
        ),
      ).toBe(true),
    );
    // And the controls reflect that state.
    expect(screen.getByRole("button", { name: "Templates" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "Sort canvases" })).toHaveValue("title");
  });

  it("Clear all resets every filter at once (plan 004)", async () => {
    const calls = stubGallery((p) => page(p.get("owner") || p.get("tag") ? [] : [item()]), {
      owners: [{ id: "u-bob", name: "bob", avatarUrl: null }],
      tags: ["charts"],
    });
    renderGallery("/gallery?owner=u-bob&templatable=true");
    expect(await screen.findByText("No gallery canvases match your filters")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await screen.findByRole("link", { name: "Budget chart" });
    expect(calls.some((c) => !c.get("owner") && !c.get("templatable") && !c.get("tag"))).toBe(true);
  });

  it("renders the Featured discovery row (admin-curated, capped at 6)", async () => {
    // 8 featured items come back; the row must cap at 6 and silently drop the rest.
    const featured = Array.from({ length: 8 }, (_, i) =>
      item({ id: `f${i}`, title: `Featured ${i}`, galleryFeatured: true }),
    );
    stubGallery(
      () => page([item({ id: "grid1", title: "Grid only" })]),
      { owners: [], tags: [] },
      (p) => (p.get("featured") === "1" ? page(featured) : page([])),
    );
    renderGallery();

    expect(await screen.findByRole("heading", { name: "Featured" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Featured 0" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Featured 5" })).toBeInTheDocument();
    // Beyond the cap is dropped.
    expect(screen.queryByRole("link", { name: "Featured 6" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Featured 7" })).not.toBeInTheDocument();
  });

  it("hides the Featured row entirely when no canvases are featured", async () => {
    // Discovery defaults to empty pages, so no featured items come back.
    stubGallery(() => page([item({ id: "g", title: "Grid only" })]));
    renderGallery();
    await screen.findByRole("link", { name: "Grid only" });
    expect(screen.queryByRole("heading", { name: "Featured" })).not.toBeInTheDocument();
  });

  it("renders the Recently published discovery strip above the grid", async () => {
    stubGallery(
      () => page([item({ id: "grid1", title: "Grid only" })]),
      { owners: [], tags: [] },
      (p) =>
        p.get("sort") === "recent" ? page([item({ id: "r1", title: "Fresh canvas" })]) : page([]),
    );
    renderGallery();
    expect(await screen.findByRole("heading", { name: "Recently published" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fresh canvas" })).toBeInTheDocument();
  });

  it("top-tag shortcut chips filter the gallery via ?tag=", async () => {
    const calls = stubGallery((p) => page([item({ title: p.get("tag") ? "Filtered" : "All" })]), {
      owners: [],
      tags: ["charts", "maps", "games"],
    });
    renderGallery();
    await screen.findByRole("link", { name: "All" });

    // The chip carries the "#tag" label; clicking it applies ?tag=.
    await userEvent.click(screen.getByRole("button", { name: "#maps" }));
    await waitFor(() => expect(calls.some((c) => c.get("tag") === "maps")).toBe(true));
  });

  it("the sort dropdown offers Featured/Trending/Recent/Title and reorders via ?sort=", async () => {
    const calls = stubGallery(() => page([item()]));
    renderGallery();
    await screen.findByRole("link", { name: "Budget chart" });

    const select = screen.getByRole("combobox", { name: "Sort canvases" });
    const labels = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(labels).toEqual(["Featured", "Trending", "Recent", "Title A–Z"]);

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sort canvases" }),
      "trending",
    );
    await waitFor(() => expect(calls.some((c) => c.get("sort") === "trending")).toBe(true));
  });

  it("the filtered empty state offers Clear filters and Browse docs", async () => {
    stubGallery((p) => (p.get("q") ? page([]) : page([item()])));
    renderGallery("/gallery?q=zzz");
    expect(await screen.findByText("No gallery canvases match your filters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse docs" })).toBeInTheDocument();
  });

  it("makes Use template prominent on templatable cards (visible button, not buried)", async () => {
    stubGallery(() => page([item({ id: "t1", templatable: true })]));
    renderGallery();
    const btn = await screen.findByRole("button", { name: "Use template" });
    expect(btn).toBeVisible();
  });

  it("the card copy affordance carries the canvas url", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    stubGallery(() => page([item({ url: "http://x/c/copyme" })]));
    renderGallery();
    const card = (await screen.findByRole("link", { name: "Budget chart" })).closest("li");
    expect(card).not.toBeNull();
    // The actions now live behind the card's overflow menu (portaled to body).
    await userEvent.click(
      within(card as HTMLElement).getByRole("button", { name: /More actions/ }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith("http://x/c/copyme");
  });
});
