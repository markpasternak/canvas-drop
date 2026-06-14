import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

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
    galleryListed: false,
    galleryTemplatable: false,
    gallerySummary: null,
    galleryTags: null,
    status: "active",
    disabledReason: null,
    currentVersionId: "v1",
    createdAt: 0,
    updatedAt: 0,
    lastDeploy: { version: 1, createdAt: 0, fileCount: 1, totalBytes: 10 },
    ...over,
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
        return json({ id: "u1", email: "u@x", name: "U", avatarUrl: null, isAdmin: false, authMode: "dev" });
      }
      if (path.endsWith("/archived")) return json({ canvases: [] });
      // /api/canvases — apply the server-side filter/search the route would.
      const sp = u.searchParams;
      const q = sp.get("q")?.toLowerCase();
      const matched = all.filter((c) => {
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Your canvases — server-side filters (plan 005)", () => {
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
    expect(await screen.findByText("Draft only")).toBeInTheDocument();
    expect(screen.queryByText("Deployed one")).toBeNull();
    // The chip reflects the URL state.
    expect(screen.getByRole("button", { name: "Never deployed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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

  it("paginates: shows the page window and a working Next control", async () => {
    // 25 canvases → page size 24 → page 1 shows 24, Next reveals the 25th.
    const many = Array.from({ length: 25 }, (_, i) =>
      canvas({ id: `c${i}`, slug: `s${i}`, title: `Canvas ${String(i).padStart(2, "0")}` }),
    );
    stub(many);
    renderAt("/?sort=title");
    expect(await screen.findByText("Showing 1–24 of 25")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Showing 25–25 of 25")).toBeInTheDocument();
  });
});
