import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    gallerySummary: null,
    galleryTags: null,
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
        if (q && !`${c.title} ${c.slug}`.toLowerCase().includes(q)) return false;
        return true;
      });
      const limit = Number(sp.get("limit") ?? 24);
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
    await screen.findByText("Shared one");
    expect(screen.getByText("Private one")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Shared" }));
    expect(await screen.findByText("Shared one")).toBeInTheDocument();
    expect(screen.queryByText("Private one")).toBeNull();
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

    await screen.findByText("Shared one");
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

    await screen.findByText("Copyable one");
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

    await screen.findByText("Outside one");
    const menu = screen.getByRole("button", { name: "More actions for Outside one" });
    await userEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("heading", { name: "Your canvases" }));

    await waitFor(() => expect(menu).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByRole("menuitem", { name: "Copy link" })).toBeNull();
  });

  it("searches by title (debounced into a server request)", async () => {
    stub([
      canvas({ id: "a", title: "Quarterly revenue" }),
      canvas({ id: "b", title: "Team poll" }),
    ]);
    renderAt("/");
    await screen.findByText("Quarterly revenue");

    await userEvent.type(screen.getByRole("searchbox", { name: "Search your canvases" }), "poll");
    // "Team poll" is in both states, so wait on the non-match disappearing — that's
    // the signal the debounced server refetch landed.
    await waitFor(() => expect(screen.queryByText("Quarterly revenue")).toBeNull());
    expect(screen.getByText("Team poll")).toBeInTheDocument();
  });

  it("composes filters and shows the filtered-empty state with Clear filters", async () => {
    stub([
      canvas({ id: "a", title: "Shared template", shared: true, galleryTemplatable: true }),
      canvas({ id: "b", title: "Plain shared", shared: true, galleryTemplatable: false }),
    ]);
    // shared AND template → only the first; narrowing further to never-deployed → none.
    renderAt("/?shared=true&template=true&undeployed=true");
    expect(await screen.findByText("No canvases match these filters")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("Shared template")).toBeInTheDocument();
    expect(screen.getByText("Plain shared")).toBeInTheDocument();
  });

  it("does not offer an unpublished-changes filter (deferred — KTD6)", async () => {
    stub([canvas({ id: "a", title: "Only one" })]);
    renderAt("/");
    await screen.findByText("Only one");
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
    await screen.findByText("Active one");
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

  it("paginates: shows the page window and a working Next control", async () => {
    // 25 canvases → page size 24 → page 1 shows 24, Next reveals the 25th.
    const many = Array.from({ length: 25 }, (_, i) =>
      canvas({ id: `c${i}`, slug: `s${i}`, title: `Canvas ${String(i).padStart(2, "0")}` }),
    );
    stub(many);
    renderAt("/?sort=title");
    expect(await screen.findAllByText("Showing 1–24 of 25")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findAllByText("Showing 25–25 of 25")).toHaveLength(2);
  });
});
