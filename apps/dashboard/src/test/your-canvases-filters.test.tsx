import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

const originalClipboard = navigator.clipboard;

/** A canvas-list row as the API serializes it (only the fields the list view reads;
 *  the fetch JSON is untyped, so we omit capability internals the row never touches). */
function canvas(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    slug: "s1",
    url: "http://x/c/s1",
    title: "Canvas One",
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
    viewCount: 0,
    lastViewedAt: null,
    createdAt: 0,
    updatedAt: 0,
    recentViews: 0,
    lastDeploy: { version: 1, createdAt: 0, fileCount: 1, totalBytes: 10 },
    ...over,
  };
}

function summaryFor(canvases: Array<ReturnType<typeof canvas>>) {
  const activeRows = canvases.filter((c) => c.status !== "archived" && c.status !== "deleted");
  return {
    active: activeRows.length,
    archived: canvases.filter((c) => c.status === "archived").length,
    shared: activeRows.filter((c) => c.shared).length,
    protected: activeRows.filter((c) => c.hasPassword).length,
    listed: activeRows.filter((c) => c.galleryListed).length,
    templates: activeRows.filter((c) => c.galleryTemplatable).length,
    neverDeployed: activeRows.filter((c) => c.lastDeploy === null).length,
  };
}

/**
 * Fake server (plan 005): `/api/canvases` now filters/searches/sorts/paginates
 * server-side, so the stub applies the same predicates from the query params and
 * returns the `{ canvases, total, limit, offset }` page shape. The view's job is to
 * send the right params and render the response — that's what these tests exercise.
 */
function stub(all: Array<ReturnType<typeof canvas>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url, "http://localhost");
      const path = u.pathname;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (path === "/api/me") {
        return json({
          id: "u1",
          email: "u@x",
          name: "U",
          avatarUrl: null,
          isAdmin: false,
          authMode: "dev",
        });
      }
      // /api/canvases — apply the server-side filter/search the route would.
      const sp = u.searchParams;
      const q = sp.get("q")?.toLowerCase();
      const archivedScope = sp.get("scope") === "archived";
      const matched = all.filter((c) => {
        // Scope is the lifecycle slice: archived view shows only archived; the
        // default active view excludes archived/deleted (mirrors the server).
        if (archivedScope) {
          if (c.status !== "archived") return false;
        } else if (c.status === "archived" || c.status === "deleted") {
          return false;
        }
        if (sp.get("shared") === "1" && !c.shared) return false;
        if (sp.get("protected") === "1" && !c.hasPassword) return false;
        if (sp.get("listed") === "1" && !c.galleryListed) return false;
        if (sp.get("template") === "1" && !c.galleryTemplatable) return false;
        if (sp.get("undeployed") === "1" && c.lastDeploy !== null) return false;
        // Multi-tag any-match (U9): a canvas matches if it carries ANY selected tag.
        const wantTags = sp.getAll("tag");
        if (wantTags.length > 0) {
          const have = Array.isArray(c.tags) ? (c.tags as string[]) : [];
          if (!wantTags.some((t) => have.includes(t))) return false;
        }
        // Forgiving search (U2): the real backend matches name/description/tags/slug
        // case-insensitively. The stub mirrors that field set so the view's search
        // wiring is exercised over the same surface.
        if (q) {
          const haystack = [
            c.title,
            (c as { description?: string | null }).description ?? "",
            ...(Array.isArray(c.tags) ? (c.tags as string[]) : []),
            c.slug,
          ]
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      });
      // Server-side ordering the route applies (plan 004 adds `popular` = trending views).
      const ordered =
        sp.get("sort") === "popular"
          ? [...matched].sort((a, b) => (b.recentViews ?? 0) - (a.recentViews ?? 0))
          : matched;
      const limit = Number(sp.get("limit") ?? 48);
      const offset = Number(sp.get("offset") ?? 0);
      return json({
        canvases: ordered.slice(offset, offset + limit),
        total: matched.length,
        limit,
        offset,
        summary: summaryFor(all),
      });
    }),
  );
}

/** Row list scope: the U11 "finish this" strip rides above the list on the sparse
 *  (≤3 / draft-led) first page these fixtures use, duplicating one canvas's title +
 *  an action. Scope row/title/action assertions here so they read the ROW, not the
 *  strip. The strip is a labelled <section>; the rows live in the page's <ul>. */
function rows(): HTMLElement {
  // The canvas rows live in a <ul> whose items carry [data-canvas-item]; scope to it
  // explicitly so an unrelated <ul> (e.g. the open tag-filter listbox) isn't picked up.
  const item = document.querySelector("[data-canvas-item]");
  const list = item?.closest("ul");
  if (!list) throw new Error("no row list rendered");
  return list as HTMLElement;
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
  // Returned so a test can assert the URL (e.g. shareable `?tag=`) the view writes.
  return router;
}

afterEach(() => {
  if (originalClipboard === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
    });
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* jsdom always has localStorage; defensive */
  }
});

// These cases predate the grid default and assert list-view structure/affordances
// (the new grid default + persistence are covered by owner-view.test.tsx). Pin the
// per-device stored layout to list so the legacy assertions hold; any `?view=` test
// still overrides it (URL wins over localStorage).
beforeEach(() => {
  try {
    localStorage.setItem("canvas-drop:owner-view", "list");
  } catch {
    /* jsdom always has localStorage; defensive */
  }
});

describe("Your canvases — server-side filters (plan 005)", () => {
  function expectMetric(label: string, value: string) {
    const metric = screen
      .getAllByText(label)
      .find((el) => el.tagName.toLowerCase() === "dt")
      ?.closest("div");
    expect(metric).not.toBeNull();
    expect(within(metric as HTMLElement).getByText(value)).toBeInTheDocument();
  }

  it("filters to shared via the Shared chip", async () => {
    stub([
      canvas({ id: "a", title: "Shared one", shared: true }),
      canvas({ id: "b", title: "Private one", shared: false }),
    ]);
    renderAt("/");
    await screen.findByText("Private one");
    expect(within(rows()).getByText("Shared one")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Shared" }));
    expect(await within(rows()).findByText("Shared one")).toBeInTheDocument();
    expect(within(rows()).queryByText("Private one")).toBeNull();
  });

  it("shows owner inventory counts on summary metrics and filter chips", async () => {
    stub([
      canvas({ id: "a", title: "Shared one", shared: true }),
      canvas({ id: "b", title: "Protected one", hasPassword: true }),
      canvas({
        id: "c",
        title: "Template draft",
        galleryListed: true,
        galleryTemplatable: true,
        lastDeploy: null,
      }),
    ]);
    renderAt("/");

    await screen.findByText("Protected one");
    expectMetric("Active", "3");
    expectMetric("Templates", "1");
    expectMetric("Never deployed", "1");
    expect(screen.getByRole("button", { name: "Shared" })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Protected" })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Templates" })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Never deployed" })).toHaveTextContent("1");
  });

  it("filters to never-deployed from the URL", async () => {
    stub([
      canvas({
        id: "a",
        title: "Deployed one",
        lastDeploy: { version: 1, createdAt: 0, fileCount: 1, totalBytes: 10 },
      }),
      canvas({ id: "b", title: "Draft only", lastDeploy: null, currentVersionId: null }),
    ]);
    renderAt("/?undeployed=true");
    expect(
      await screen.findByRole("link", { name: "View details for Draft only" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Deployed one")).toBeNull();
    // The chip reflects the URL state.
    expect(screen.getByRole("button", { name: "Never deployed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("uses a setup action for never-deployed canvases instead of copy/open link actions", async () => {
    stub([canvas({ id: "draft", title: "Draft only", lastDeploy: null, currentVersionId: null })]);
    renderAt("/");

    expect(
      await screen.findByRole("link", { name: "View details for Draft only" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue setup for Draft only" })).toHaveAttribute(
      "href",
      "/canvases/draft/editor",
    );
    expect(screen.queryByRole("button", { name: "Copy link for Draft only" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open Draft only" })).toBeNull();
  });

  it("closes the overflow menu after copying a link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    stub([canvas({ id: "copy", title: "Copyable one" })]);
    renderAt("/");

    await screen.findAllByText("Copyable one");
    const menu = screen.getByRole("button", { name: "More actions for Copyable one" });
    await userEvent.click(menu);
    const copy = await screen.findByRole("menuitem", { name: "Copy link" });
    expect(menu).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(copy);

    await waitFor(() => expect(menu).toHaveAttribute("aria-expanded", "false"));
    expect(writeText).toHaveBeenCalledWith("http://x/c/s1");
  });

  it("closes the overflow menu when clicking outside it", async () => {
    stub([canvas({ id: "outside", title: "Outside one" })]);
    renderAt("/");

    await screen.findAllByText("Outside one");
    const menu = screen.getByRole("button", { name: "More actions for Outside one" });
    await userEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("heading", { name: "Your canvases" }));

    await waitFor(() => expect(menu).toHaveAttribute("aria-expanded", "false"));
    // The dropdown animates OUT before unmounting (~150ms exit delay), so wait for
    // it to leave the DOM rather than asserting synchronously.
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Copy link" })).toBeNull());
  });

  it("searches by title (debounced into a server request)", async () => {
    stub([
      canvas({ id: "a", title: "Quarterly revenue" }),
      canvas({ id: "b", title: "Team poll" }),
    ]);
    renderAt("/");
    await screen.findByText("Team poll");

    await userEvent.type(screen.getByRole("searchbox", { name: "Search your canvases" }), "poll");
    // "Team poll" is in both states, so wait on the non-match disappearing — that's
    // the signal the debounced server refetch landed.
    await waitFor(() => expect(screen.queryByText("Quarterly revenue")).toBeNull());
    expect(within(rows()).getByText("Team poll")).toBeInTheDocument();
  });

  it("composes filters and shows the filtered-empty state with Clear all filters", async () => {
    stub([
      canvas({ id: "a", title: "Shared template", shared: true, galleryTemplatable: true }),
      canvas({ id: "b", title: "Plain shared", shared: true, galleryTemplatable: false }),
    ]);
    // shared AND template → only the first; narrowing further to never-deployed → none.
    renderAt("/?shared=true&template=true&undeployed=true");
    expect(await screen.findByText("No canvases match these filters")).toBeInTheDocument();

    // U7 filtered variant: the single action is "Clear all filters".
    await userEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
    expect(await within(rows()).findByText("Shared template")).toBeInTheDocument();
    expect(within(rows()).getByText("Plain shared")).toBeInTheDocument();
  });

  it("does not offer an unpublished-changes filter (deferred — KTD6)", async () => {
    stub([canvas({ id: "a", title: "Only one" })]);
    renderAt("/");
    await screen.findAllByText("Only one");
    expect(screen.queryByRole("button", { name: /unpublished/i })).toBeNull();
  });

  it("shows onboarding for a truly empty list (no active filters)", async () => {
    stub([]);
    renderAt("/");
    // Zero owned canvases with no active filter → the onboarding/empty path.
    expect(await screen.findByText(/ship your first canvas/i)).toBeInTheDocument();
    expect(screen.queryByText("No canvases match these filters")).toBeNull();
  });

  it("toggles to the Archived scope: requests scope=archived and renders the Restore action", async () => {
    stub([
      canvas({ id: "act", slug: "act", title: "Active one", status: "active" }),
      canvas({ id: "arc", slug: "arc", title: "Archived one", status: "archived" }),
    ]);
    renderAt("/");
    await screen.findAllByText("Active one");
    // The archived canvas is not in the default (active) scope.
    expect(screen.queryByText("Archived one")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /archived/i }));

    // Archived scope: the archived row appears, the active one drops out, and the
    // row exposes Restore (not Open) — the ArchivedRow branch.
    expect(await screen.findByText("Archived one")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Active one")).toBeNull());
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Archived one" })).toBeNull();
  });

  it("colour-codes the stat strip + filter chips with concept dots, and the row badges (rebrand)", async () => {
    stub([
      canvas({
        id: "a",
        title: "Listed template",
        galleryListed: true,
        galleryTemplatable: true,
        hasPassword: true,
      }),
    ]);
    renderAt("/");
    await screen.findAllByText("Listed template");

    // Stat strip: each stat carries its concept on a data attribute (the dot rides it).
    // Scope to the <dt> (the stat label) — "Active"/"Archived" also appear in the
    // scope toggle, so match on the strip's definition-term cells only.
    const stripLabel = screen
      .getAllByText("Active")
      .find((el) => el.tagName.toLowerCase() === "dt");
    const strip = stripLabel?.closest("dl");
    expect(strip).not.toBeNull();
    const concepts = within(strip as HTMLElement)
      .getAllByText(/^(Active|Archived|Templates|Never deployed|Protected)$/)
      .map((el) => el.closest("[data-concept]")?.getAttribute("data-concept"));
    expect(concepts).toEqual(
      expect.arrayContaining(["active", "archived", "templates", "neverDeployed", "protected"]),
    );

    // Each stat cell renders a per-concept accent icon TILE (the -subtle wash + the
    // concept-coloured glyph) alongside its number — the visual upgrade. Spot-check
    // the Templates cell: the tile carries the accent (teal) text + bg classes from
    // the shared concept map, holds an svg glyph, and the cell shows its count.
    const templatesLabel = within(strip as HTMLElement)
      .getAllByText("Templates")
      .find((el) => el.tagName.toLowerCase() === "dt");
    const templatesCell = templatesLabel?.closest("[data-concept]") as HTMLElement;
    expect(templatesCell).not.toBeNull();
    const templatesTile = templatesCell.querySelector(".text-accent.bg-accent-subtle");
    expect(templatesTile).not.toBeNull();
    expect((templatesTile as HTMLElement).querySelector("svg")).not.toBeNull();
    expect(within(templatesCell).getByText("1")).toBeInTheDocument();

    // Filter chips carry the same concept colours: the Listed chip's dot is the
    // info (blue) tint that the Listed row badge also uses. (Several controls match
    // /listed/i — the toggle chip is the one carrying aria-pressed.)
    const listedChip = screen
      .getAllByRole("button", { name: /listed/i })
      .find((b) => b.getAttribute("aria-pressed") !== null);
    expect(listedChip).toBeDefined();
    expect((listedChip as HTMLElement).querySelector(".bg-info")).not.toBeNull();

    // Row badges read the concept tints from the same map. "Template"/"Protected"
    // text also appears as a stat label, so target the row badge by its data-concept.
    const templateBadge = screen.getByText("Template");
    expect(templateBadge).toHaveAttribute("data-concept", "templates");
    expect(templateBadge.className).toContain("text-accent");
    const protectedBadge = document.querySelector('span[data-concept="protected"]');
    expect(protectedBadge).not.toBeNull();
    expect((protectedBadge as HTMLElement).className).toContain("text-warning");
    expect(protectedBadge).toHaveTextContent("Protected");
  });

  it("renders the list view flat — no boxy card around the rows, a hairline column header", async () => {
    stub([canvas({ id: "a", slug: "sa", title: "Alpha" })]);
    renderAt("/");
    await screen.findAllByText("Alpha");

    // The flat (Lovable-style) list has a quiet "Canvas" column header carrying the
    // select-all checkbox. Its wrapper is a hairline divider underneath — a bottom
    // border, not a filled sunken bar — and it is NOT wrapped in a bordered card.
    const selectAll = screen.getByRole("checkbox", {
      name: "Select all canvases on this page",
    });
    const header = selectAll.closest("div") as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.className).toContain("border-b");
    // Flattened: the old filled sunken bar + rounded-top card chrome is gone.
    expect(header.className).not.toContain("bg-surface-sunken");
    expect(header.className).not.toContain("rounded-t-lg");

    // The list container that wraps the header + rows no longer carries the boxy
    // card classes (border / surface background / rounded-lg) it used to.
    const listContainer = header.parentElement as HTMLElement;
    expect(listContainer.className).not.toContain("lg:rounded-lg");
    expect(listContainer.className).not.toContain("lg:border");
    expect(listContainer.className).not.toContain("lg:bg-surface");

    // Rows are still separated by hairline dividers (divide-y) on the page bg.
    const list = listContainer.querySelector("ul") as HTMLElement;
    expect(list.className).toContain("lg:divide-y");
  });

  it("flat list keeps select-all working — toggles every row on the page", async () => {
    stub([
      canvas({ id: "a", slug: "sa", title: "Alpha" }),
      canvas({ id: "b", slug: "sb", title: "Beta" }),
    ]);
    renderAt("/");
    await screen.findAllByText("Alpha");

    const selectAll = screen.getByRole("checkbox", {
      name: "Select all canvases on this page",
    }) as HTMLInputElement;
    const rowA = screen.getByRole("checkbox", { name: "Select Alpha" }) as HTMLInputElement;
    const rowB = screen.getByRole("checkbox", { name: "Select Beta" }) as HTMLInputElement;

    await userEvent.click(selectAll);
    expect(rowA.checked).toBe(true);
    expect(rowB.checked).toBe(true);
    expect(await screen.findByText("2 canvases selected")).toBeInTheDocument();

    // Indeterminate state: unticking one row leaves the header checkbox partial.
    await userEvent.click(rowA);
    expect(selectAll.indeterminate).toBe(true);
    expect(selectAll.checked).toBe(false);

    // Toggling select-all off again clears the page.
    await userEvent.click(selectAll);
    // (header was indeterminate → click sets it checked, selecting all again)
    expect(rowA.checked).toBe(true);
    expect(rowB.checked).toBe(true);
  });

  it("paginates: shows the page window and a working Next control", async () => {
    // 49 canvases → page size 48 → page 1 shows 48, Next reveals the 49th.
    const many = Array.from({ length: 49 }, (_, i) =>
      canvas({ id: `c${i}`, slug: `s${i}`, title: `Canvas ${String(i).padStart(2, "0")}` }),
    );
    stub(many);
    renderAt("/?sort=title");
    expect(await screen.findAllByText("Showing 1–48 of 49")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findAllByText("Showing 49–49 of 49")).toHaveLength(2);
  });

  it("Most popular sort ranks by trending views and shows the per-row view count (plan 004)", async () => {
    stub([
      canvas({ id: "warm", title: "Warm canvas", recentViews: 3 }),
      canvas({ id: "hot", title: "Hot canvas", recentViews: 9 }),
    ]);
    // Selecting "Most popular" requests sort=popular; the stub returns trending order.
    renderAt("/?sort=popular");
    await screen.findAllByText("Hot canvas");
    const hot = within(rows()).getByText("Hot canvas");
    const warm = within(rows()).getByText("Warm canvas");
    // Hot (9) ranks above Warm (3) — DOM order reflects the server ranking.
    expect(hot.compareDocumentPosition(warm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The per-row trending count is rendered (list-view "Views" stat).
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  // ── U9: tag filter + smarter search + per-state empties ──────────────────────

  it("hides the tag filter when no tags are available", async () => {
    stub([canvas({ id: "a", title: "Untagged", tags: null })]);
    renderAt("/");
    await screen.findAllByText("Untagged");
    // TagFilter renders nothing when availableTags is empty.
    expect(screen.queryByRole("button", { name: "Filter by tag" })).toBeNull();
  });

  it("filters by one tag, narrows the list, and writes a shareable ?tag=", async () => {
    stub([
      canvas({ id: "a", title: "Charts one", tags: ["charts"] }),
      canvas({ id: "b", title: "Forms one", tags: ["forms"] }),
    ]);
    const router = renderAt("/");
    await screen.findAllByText("Charts one");

    await userEvent.click(screen.getByRole("button", { name: "Filter by tag" }));
    await userEvent.click(await screen.findByRole("option", { name: /charts/i }));

    // Only the charts canvas remains, and the URL carries the shareable tag param.
    await waitFor(() => expect(within(rows()).queryByText("Forms one")).toBeNull());
    expect(within(rows()).getByText("Charts one")).toBeInTheDocument();
    await waitFor(() =>
      expect((router.state.location.search as { tag?: unknown }).tag).toEqual(["charts"]),
    );
  });

  it("multiple tags any-match (shareable URL); removing a chip narrows back", async () => {
    stub([
      canvas({ id: "a", title: "Charts one", tags: ["charts"] }),
      canvas({ id: "b", title: "Forms one", tags: ["forms"] }),
      canvas({ id: "c", title: "Docs one", tags: ["docs"] }),
    ]);
    // A shareable two-tag URL: any-match returns canvases carrying EITHER tag.
    const router = renderAt("/?tag=charts&tag=forms");
    expect(await screen.findByText("Charts one")).toBeInTheDocument();
    expect(screen.getByText("Forms one")).toBeInTheDocument();
    expect(screen.queryByText("Docs one")).toBeNull();

    // Both selections render as removable chips; removing one narrows to its remainder.
    await userEvent.click(screen.getByRole("button", { name: "Remove tag forms" }));
    await waitFor(() => expect(screen.queryByText("Forms one")).toBeNull());
    expect(screen.getByText("Charts one")).toBeInTheDocument();
    await waitFor(() =>
      expect((router.state.location.search as { tag?: unknown }).tag).toEqual(["charts"]),
    );
  });

  it("search is forgiving over the new fields (matches a tag) and updates the list", async () => {
    stub([
      canvas({ id: "a", title: "Quarterly revenue", tags: ["finance"] }),
      canvas({ id: "b", title: "Team poll", tags: ["hr"] }),
    ]);
    renderAt("/");
    await screen.findAllByText("Quarterly revenue");
    // "finance" is only a TAG of the first canvas — forgiving search matches it.
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search your canvases" }),
      "finance",
    );
    await waitFor(() => expect(within(rows()).queryByText("Team poll")).toBeNull());
    expect(within(rows()).getByText("Quarterly revenue")).toBeInTheDocument();
  });

  it("zero-result-with-search shows the search empty; Clear search preserves other filters", async () => {
    stub([canvas({ id: "a", title: "Shared one", shared: true, tags: ["alpha"] })]);
    // A shared filter is active AND a search term that matches nothing.
    renderAt("/?shared=true&q=zzz-no-match");
    expect(await screen.findByText(/no canvases match your search/i)).toBeInTheDocument();

    // The single action is "Clear search" (not "Clear all filters").
    expect(screen.queryByRole("button", { name: "Clear all filters" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));

    // q cleared → the shared filter is preserved, so the shared canvas comes back and
    // the Shared chip stays pressed.
    expect(await screen.findByText("Shared one")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Shared" })).toHaveAttribute("aria-pressed", "true");
  });

  it("zero-result-with-tag-filter shows the filtered empty with Clear all filters", async () => {
    stub([canvas({ id: "a", title: "Charts one", tags: ["charts"] })]);
    // A tag that no visible canvas carries → filtered empty (a non-search filter).
    renderAt("/?tag=ghost");
    expect(await screen.findByText("No canvases match these filters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear all filters" })).toBeInTheDocument();
    // Not the search variant.
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  it("archived scope with none shows the archived empty pointing back to active", async () => {
    stub([canvas({ id: "a", title: "Only active", status: "active" })]);
    renderAt("/?scope=archived");
    // The U7 archived variant's single action is the unique signal here ("No archived
    // canvases" also appears as the result-count label, so match on the action link).
    expect(await screen.findByRole("link", { name: "View active canvases" })).toBeInTheDocument();
    expect(screen.getAllByText("No archived canvases").length).toBeGreaterThan(0);
  });

  it("truly-empty list shows the first-run onboarding (Onboarding owns the zero state)", async () => {
    // Per the plan (R2 / U11) the zero-state is the richer Onboarding page, not the
    // minimal first-run EmptyState factory; the owner list defers to it for a pristine
    // (no filter, no search) empty library.
    stub([]);
    renderAt("/");
    expect(await screen.findByText(/ship your first canvas/i)).toBeInTheDocument();
    expect(screen.queryByText("No canvases match these filters")).toBeNull();
    expect(screen.queryByText(/no canvases match your search/i)).toBeNull();
  });
});
