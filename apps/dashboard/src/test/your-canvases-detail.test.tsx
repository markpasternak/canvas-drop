import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

const originalClipboard = navigator.clipboard;

/** A canvas-list row as the API serializes it (the fields the list view reads). */
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
      const sp = u.searchParams;
      const archivedScope = sp.get("scope") === "archived";
      const matched = all.filter((c) => {
        if (archivedScope) return c.status === "archived";
        return c.status !== "archived" && c.status !== "deleted";
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

/** The route container carries the focused canvas as `data-selected-canvas`. */
function selectedAttr(): string | null {
  return (
    document.querySelector("[data-selected-canvas]")?.getAttribute("data-selected-canvas") ?? null
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

describe("Your canvases — detail-rail focus (?selected)", () => {
  it("clicking a card body sets ?selected without navigating away", async () => {
    stub([canvas({ id: "alpha", slug: "alpha", title: "Alpha canvas" })]);
    const router = renderAt("/?view=grid");
    await screen.findByText("Alpha canvas");
    expect(selectedAttr()).toBeNull();

    // The card body is the title's parent <li>; click an area that is not an
    // interactive child (the meta line).
    await userEvent.click(screen.getByText(/Edited/));

    await waitFor(() => expect(selectedAttr()).toBe("alpha"));
    // Still on the library route, not the detail route.
    expect(router.state.location.pathname).toBe("/");
    expect(router.state.location.search).toMatchObject({ selected: "alpha" });
    // The canvas is still in the library (its title link). With a selection the rail
    // also shows the title (an <h2>), so scope to the library link to stay specific.
    expect(screen.getByRole("link", { name: "View details for Alpha canvas" })).toBeInTheDocument();
  });

  it("clicking a row body sets ?selected without navigating away (list view)", async () => {
    stub([canvas({ id: "row1", slug: "row1", title: "Row canvas" })]);
    const router = renderAt("/");
    await screen.findByText("Row canvas");

    // The slug line in the row is a non-interactive body region.
    await userEvent.click(screen.getByText("row1"));

    await waitFor(() => expect(selectedAttr()).toBe("row1"));
    expect(router.state.location.pathname).toBe("/");
  });

  it("clicking Open / checkbox / kebab does NOT focus the canvas", async () => {
    stub([canvas({ id: "alpha", slug: "alpha", title: "Alpha canvas" })]);
    renderAt("/");
    await screen.findByText("Alpha canvas");

    // Open link (interactive child) must not set focus.
    await userEvent.click(screen.getByRole("link", { name: "Open Alpha canvas" }));
    expect(selectedAttr()).toBeNull();

    // The multi-select checkbox must not set focus.
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Alpha canvas" }));
    expect(selectedAttr()).toBeNull();

    // The overflow kebab must not set focus.
    await userEvent.click(screen.getByRole("button", { name: "More actions for Alpha canvas" }));
    expect(selectedAttr()).toBeNull();
  });

  it("focusing another canvas updates ?selected", async () => {
    stub([
      canvas({ id: "one", slug: "one", title: "First canvas" }),
      canvas({ id: "two", slug: "two", title: "Second canvas" }),
    ]);
    renderAt("/");
    await screen.findByText("First canvas");

    await userEvent.click(screen.getByText("one"));
    await waitFor(() => expect(selectedAttr()).toBe("one"));

    await userEvent.click(screen.getByText("two"));
    await waitFor(() => expect(selectedAttr()).toBe("two"));
  });

  it("Enter on a focused row focuses it", async () => {
    stub([canvas({ id: "kb", slug: "kb", title: "Keyboard canvas" })]);
    renderAt("/");
    await screen.findByText("Keyboard canvas");

    // Fire Enter from a non-interactive body element inside the row.
    const body = screen.getByText("kb");
    body.focus();
    await userEvent.type(body, "{Enter}");

    await waitFor(() => expect(selectedAttr()).toBe("kb"));
  });

  it("ignores an invalid / unknown ?selected", async () => {
    stub([canvas({ id: "real", slug: "real", title: "Real canvas" })]);
    renderAt("/?selected=does-not-exist");
    await screen.findByText("Real canvas");

    // Unknown id is not on the visible page → not reflected as a focus.
    expect(selectedAttr()).toBeNull();
  });
});

describe("Your canvases — detail rail (two-pane / drawer)", () => {
  /** The detail rail (inline at xl, drawer below) is the canvas-details region. */
  function detailRegion(): HTMLElement | null {
    return document.querySelector('[aria-label="Canvas details"]');
  }

  it("renders the DetailPanel for the focused canvas (its title in the rail)", async () => {
    stub([canvas({ id: "alpha", slug: "alpha", title: "Alpha canvas" })]);
    renderAt("/?selected=alpha");
    // Wait on the library link (unambiguous — the rail's title is an <h2>).
    await screen.findByRole("link", { name: "View details for Alpha canvas" });

    // The rail renders with the focused canvas's title (a heading, distinct from
    // the row's link text). jsdom's stubbed matchMedia reports below-xl, so this
    // is the drawer path.
    await waitFor(() => {
      const region = detailRegion();
      expect(region).not.toBeNull();
      expect(region?.querySelector("h2")?.textContent).toBe("Alpha canvas");
    });
  });

  it("renders no detail rail when nothing is focused", async () => {
    stub([canvas({ id: "alpha", slug: "alpha", title: "Alpha canvas" })]);
    renderAt("/");
    await screen.findByText("Alpha canvas");

    expect(selectedAttr()).toBeNull();
    // The full-width library: no canvas-details region in the DOM.
    expect(detailRegion()).toBeNull();
  });

  it("selecting a canvas opens the rail; clearing it removes the rail", async () => {
    stub([canvas({ id: "alpha", slug: "alpha", title: "Alpha canvas" })]);
    const router = renderAt("/");
    await screen.findByText("Alpha canvas");
    expect(detailRegion()).toBeNull();

    await userEvent.click(screen.getByText(/Edited/));
    await waitFor(() => expect(detailRegion()).not.toBeNull());
    expect(selectedAttr()).toBe("alpha");

    // Clearing the selection (drop ?selected) removes the rail.
    router.navigate({ to: "/", search: {} });
    await waitFor(() => expect(detailRegion()).toBeNull());
    expect(selectedAttr()).toBeNull();
  });

  it("drawer (narrow): Escape closes and clears the selection", async () => {
    stub([canvas({ id: "alpha", slug: "alpha", title: "Alpha canvas" })]);
    renderAt("/?selected=alpha");
    await screen.findByRole("link", { name: "View details for Alpha canvas" });

    // The drawer is a focus-trapped dialog (matchMedia stub → below xl).
    const dialog = await screen.findByRole("dialog", { name: "Canvas details" });
    expect(dialog).toBeInTheDocument();

    // Escape routes through onClose → setFocused(undefined): the rail closes and
    // the focus (?selected / data-selected-canvas) is cleared.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(selectedAttr()).toBeNull());
    expect(document.querySelector('[aria-label="Canvas details"]')).toBeNull();
  });

  it("drawer (narrow): the close button clears the selection", async () => {
    stub([canvas({ id: "alpha", slug: "alpha", title: "Alpha canvas" })]);
    renderAt("/?selected=alpha");
    await screen.findByRole("dialog", { name: "Canvas details" });

    await userEvent.click(screen.getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(selectedAttr()).toBeNull());
  });

  it("Duplicate in the rail opens the shared clone confirm dialog (U4)", async () => {
    stub([canvas({ id: "alpha", slug: "alpha", title: "Alpha canvas" })]);
    renderAt("/?selected=alpha");
    // The rail (drawer below xl) is up for the focused canvas.
    const dialog = await screen.findByRole("dialog", { name: "Canvas details" });
    expect(dialog).toBeInTheDocument();

    // The Duplicate action is enabled (onDuplicate is wired by the route).
    const duplicate = screen.getByRole("button", { name: "Duplicate Alpha canvas" });
    expect(duplicate).toBeEnabled();
    await userEvent.click(duplicate);

    // The shared CloneDialog confirm opens — its body explains the clone (naming the
    // source as "Copy of …") and offers the "Duplicate canvas" confirm button.
    expect(await screen.findByText(/Copy of/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Duplicate canvas$/ })).toBeInTheDocument();
  });

  it("keeps the bulk-action bar working with a canvas focused", async () => {
    stub([canvas({ id: "alpha", slug: "alpha", title: "Alpha canvas" })]);
    renderAt("/?selected=alpha");
    await screen.findByRole("link", { name: "View details for Alpha canvas" });
    // The rail is up.
    await waitFor(() => expect(selectedAttr()).toBe("alpha"));

    // Multi-select is independent of the focus: ticking the checkbox surfaces the
    // bulk-action bar while the rail stays focused.
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Alpha canvas" }));
    expect(await screen.findByText(/1 canvas selected/i)).toBeInTheDocument();
    // Focus is untouched by the multi-select.
    expect(selectedAttr()).toBe("alpha");
  });
});
