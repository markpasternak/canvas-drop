import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardNotFoundState, DashboardRouteErrorState } from "../components/ErrorState.js";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

function renderApp(initialPath: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
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

function renderTestRouter(router: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  // The rail collapse choice persists in localStorage; clear it so tests don't bleed.
  try {
    localStorage.removeItem("canvas-drop-nav-collapsed");
  } catch {
    /* jsdom always has localStorage; guard anyway */
  }
});

describe("dashboard app", () => {
  it("renders the shell and, with zero canvases, the onboarding first-run page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ canvases: [], total: 0, limit: 24, offset: 0 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    renderApp("/");
    // shell chrome — the wordmark renders in both the left rail and the mobile
    // top bar (both in the DOM under jsdom; CSS shows one per width).
    expect((await screen.findAllByText("canvas-drop")).length).toBeGreaterThanOrEqual(1);
    // empty list → onboarding
    expect(await screen.findByText(/ship your first canvas/i)).toBeInTheDocument();
    expect(screen.getByText(/paste html/i)).toBeInTheDocument();
  });

  it("points at the Archived view when every canvas is archived (not onboarding)", async () => {
    // The empty-home pointer reads the archived count from the list response summary:
    // an empty active list whose summary reports one archived canvas.
    const emptySummary = {
      active: 0,
      archived: 1,
      shared: 0,
      protected: 0,
      listed: 0,
      templates: 0,
      neverDeployed: 0,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ canvases: [], total: 0, limit: 24, offset: 0, summary: emptySummary }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    renderApp("/");
    expect(await screen.findByText(/no active canvases/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view archived/i })).toBeInTheDocument();
    // The brand-new-user onboarding must NOT appear when archived canvases exist.
    expect(screen.queryByText(/ship your first canvas/i)).toBeNull();
  });

  it("shows the canvas rows when the list is non-empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              canvases: [
                {
                  id: "c1",
                  slug: "quiet-otter",
                  url: "http://x/c/quiet-otter",
                  title: "My Canvas",
                  description: null,
                  shared: false,
                  sharedExpiresAt: null,
                  hasPassword: false,
                  spaFallback: false,
                  previewMode: "auto",
                  galleryListed: false,
                  gallerySummary: null,
                  galleryTags: null,
                  status: "active",
                  publicationState: "published",
                  disabledReason: null,
                  currentVersionId: "v1",
                  createdAt: 0,
                  updatedAt: 0,
                  lastDeploy: { version: 1, createdAt: Date.now(), fileCount: 1, totalBytes: 10 },
                },
              ],
              total: 1,
              limit: 24,
              offset: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    renderApp("/");
    expect(await screen.findByText("My Canvas")).toBeInTheDocument();
    expect(screen.getByText("quiet-otter")).toBeInTheDocument();
  });

  it("mobile menu: the menu button toggles a second copy of the section links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ canvases: [], total: 0, limit: 24, offset: 0 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    renderApp("/");
    await screen.findAllByText("canvas-drop");
    const user = userEvent.setup();

    // Closed: only the (always-rendered) desktop nav has the Gallery link.
    expect(screen.getAllByRole("link", { name: "Gallery" })).toHaveLength(1);

    const toggle = screen.getByRole("button", { name: "Open menu" });
    await user.click(toggle);
    // Open: the mobile menu adds a second copy of each section link.
    expect(screen.getAllByRole("link", { name: "Gallery" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Close menu" })).toBeInTheDocument();

    // Selecting a link in the menu closes it (back to the single desktop copy).
    const menuGallery = screen.getAllByRole("link", { name: "Gallery" }).at(-1);
    if (!menuGallery) throw new Error("expected a menu Gallery link");
    await user.click(menuGallery);
    expect(screen.getAllByRole("link", { name: "Gallery" })).toHaveLength(1);
  });

  /** Path-aware stub: lets a test set what /api/me reports for isAdmin. */
  function stubFetch(isAdmin: boolean) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url, "http://localhost").pathname;
        const body =
          path === "/api/me"
            ? { id: "u1", email: "u@x", name: "U", avatarUrl: null, isAdmin, authMode: "dev" }
            : { canvases: [], total: 0, limit: 24, offset: 0 };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  }

  it("Admin is visible to admins and sits last — to the right of Gallery", async () => {
    stubFetch(true);
    renderApp("/");
    // Wait for the admin-gated link to appear after /api/me resolves.
    await screen.findByRole("link", { name: "Admin" });
    // The (always-rendered) desktop section nav is the first "Sections" landmark.
    const [desktopNav] = screen.getAllByRole("navigation", { name: "Sections" });
    if (!desktopNav) throw new Error("expected the desktop Sections nav");
    const order = within(desktopNav)
      .getAllByRole("link")
      .map((a) => a.textContent);
    expect(order).toEqual(["Canvases", "Gallery", "Admin"]);
  });

  it("Admin is hidden from non-admins (UX layer of the admin-only boundary)", async () => {
    stubFetch(false);
    renderApp("/");
    await screen.findByRole("link", { name: "Gallery" });
    const [desktopNav] = screen.getAllByRole("navigation", { name: "Sections" });
    if (!desktopNav) throw new Error("expected the desktop Sections nav");
    expect(within(desktopNav).queryByRole("link", { name: "Admin" })).toBeNull();
  });

  it("left rail: brand, Create canvas, the section nav, and the account menu all render", async () => {
    stubFetch(false);
    renderApp("/");
    // The account menu is pinned in the rail (and the mobile top bar) — it renders
    // once /api/me resolves.
    await screen.findAllByRole("button", { name: /^Account:/ });
    // The teal brand tile links home.
    expect(screen.getAllByRole("link", { name: "canvas-drop home" }).length).toBeGreaterThanOrEqual(
      1,
    );
    // The dominant create action is the prominent rail button → /new.
    const create = screen.getAllByRole("link", { name: "Create canvas" });
    expect(create.length).toBeGreaterThanOrEqual(1);
    expect(create[0]?.getAttribute("href")).toBe("/new");
  });

  it("left rail: the active route is marked aria-current and a section link navigates", async () => {
    stubFetch(false);
    renderApp("/");
    await screen.findByRole("link", { name: "Gallery" });
    const [railNav] = screen.getAllByRole("navigation", { name: "Sections" });
    if (!railNav) throw new Error("expected the rail Sections nav");
    // On "/", Canvases is the active item (aria-current=page).
    const canvases = within(railNav).getByRole("link", { name: "Canvases" });
    await waitFor(() => expect(canvases).toHaveAttribute("aria-current", "page"));
    expect(within(railNav).getByRole("link", { name: "Gallery" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );

    // Navigating to Gallery moves the active marker.
    const user = userEvent.setup();
    await user.click(within(railNav).getByRole("link", { name: "Gallery" }));
    await waitFor(() =>
      expect(within(railNav).getByRole("link", { name: "Gallery" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
  });

  it("mobile menu: clicking the backdrop closes the menu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ canvases: [], total: 0, limit: 24, offset: 0 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    renderApp("/");
    await screen.findAllByText("canvas-drop");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getAllByRole("link", { name: "Gallery" })).toHaveLength(2);

    // The backdrop is aria-hidden (out of the a11y tree), so target it by test id.
    await user.click(screen.getByTestId("menu-backdrop"));
    expect(screen.getAllByRole("link", { name: "Gallery" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
  });

  it("mobile menu: opening moves focus into the menu, Escape closes + restores focus, Tab cycles within", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ canvases: [], total: 0, limit: 24, offset: 0 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    renderApp("/");
    await screen.findAllByText("canvas-drop");
    const user = userEvent.setup();

    const toggle = screen.getByRole("button", { name: "Open menu" });
    await user.click(toggle);

    // Opening moves focus into the menu — onto its first link (Canvases).
    const menuNav = screen.getAllByRole("navigation", { name: "Sections" }).at(-1);
    if (!menuNav) throw new Error("expected the mobile Sections nav");
    const menuLinks = within(menuNav).getAllByRole("link");
    await waitFor(() => expect(menuLinks[0]).toHaveFocus());

    // Tab cycles within the menu: shift+Tab from the first focusable wraps to the
    // LAST focusable in the menu. The menu footer adds a Docs anchor + theme
    // buttons after the section links, so the last focusable is the trailing theme
    // control — not the last section link. The trap stays inside the menu either way.
    const menuFocusables = menuNav.querySelectorAll<HTMLElement>("a[href],button:not([disabled])");
    const lastFocusable = menuFocusables[menuFocusables.length - 1];
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(menuNav.contains(document.activeElement)).toBe(true);
    expect(lastFocusable).toHaveFocus();

    // Escape closes the menu and restores focus to the toggle.
    await user.keyboard("{Escape}");
    expect(screen.getAllByRole("link", { name: "Gallery" })).toHaveLength(1);
    const reopened = screen.getByRole("button", { name: "Open menu" });
    expect(reopened).toHaveFocus();
  });

  it("left rail: the collapse toggle collapses/expands the rail and flips its aria state", async () => {
    stubFetch(false);
    renderApp("/");
    await screen.findByRole("link", { name: "Gallery" });
    const user = userEvent.setup();

    // Expanded by default: the wordmark + nav labels are visible, toggle reads
    // "Collapse sidebar" with aria-expanded=true.
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const [railNav] = screen.getAllByRole("navigation", { name: "Sections" });
    if (!railNav) throw new Error("expected the rail Sections nav");
    // The visible label text is present while expanded.
    expect(within(railNav).getByText("Gallery")).toBeInTheDocument();

    // Collapse it.
    await user.click(toggle);
    const expandToggle = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expandToggle).toHaveAttribute("aria-expanded", "false");
    // Collapsed: the wordmark text is gone (the home link keeps its aria-label),
    // and the nav label text is gone — but the icon link keeps its accessible name.
    const [collapsedRail] = screen.getAllByRole("navigation", { name: "Sections" });
    if (!collapsedRail) throw new Error("expected the collapsed rail Sections nav");
    expect(within(collapsedRail).queryByText("Gallery")).toBeNull();
    // Accessible name survives via aria-label even though the visible text is gone.
    expect(within(collapsedRail).getByRole("link", { name: "Gallery" })).toBeInTheDocument();
    // The rail brand no longer renders the "canvas-drop" wordmark text (only the
    // mobile top bar copy remains).
    expect(screen.getAllByText("canvas-drop")).toHaveLength(1);

    // Expand again restores the labels.
    await user.click(expandToggle);
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
    const [reRail] = screen.getAllByRole("navigation", { name: "Sections" });
    if (!reRail) throw new Error("expected the re-expanded rail Sections nav");
    expect(within(reRail).getByText("Gallery")).toBeInTheDocument();
  });

  it("left rail: the collapse choice persists in localStorage and is read on next mount", async () => {
    stubFetch(false);
    // First mount: collapse the rail, which should write the persistence key.
    const first = renderApp("/");
    await screen.findByRole("link", { name: "Gallery" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(localStorage.getItem("canvas-drop-nav-collapsed")).toBe("1");
    first.unmount();

    // Second mount reads the stored choice and starts collapsed.
    renderApp("/");
    await screen.findByRole("link", { name: "Gallery" });
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("detail lives under /canvases/:id (NOT /c/:id, which is canvas content in path mode)", async () => {
    const canvas = {
      id: "c1",
      slug: "quiet-otter",
      url: "http://x/c/quiet-otter",
      title: "Team poll",
      description: null,
      shared: false,
      sharedExpiresAt: null,
      hasPassword: false,
      spaFallback: false,
      previewMode: "auto",
      galleryListed: false,
      gallerySummary: null,
      galleryTags: null,
      status: "active",
      publicationState: "published",
      disabledReason: null,
      currentVersionId: "v1",
      createdAt: 0,
      updatedAt: 0,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.endsWith("/versions") ? { versions: [] } : canvas;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    renderApp("/canvases/c1");
    // the detail shell renders (breadcrumb + title), proving the route resolves
    expect(await screen.findByText("Your canvases")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Team poll" })).toBeInTheDocument();
  });

  it("shows the designed dashboard 404 for unknown SPA routes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "u1",
              email: "mark@example.com",
              name: "Mark",
              avatarUrl: null,
              isAdmin: false,
              authMode: "dev",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    renderApp("/missing-dashboard-route");

    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText("not_found")).toBeInTheDocument();
    expect(screen.getByText("/missing-dashboard-route")).toBeInTheDocument();
  });

  it("the rail exposes Docs as a real anchor to the server-served /docs, opening a new tab", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ canvases: [], total: 0, limit: 24, offset: 0 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    renderApp("/");
    await screen.findAllByText("canvas-drop");
    const docs = screen.getByRole("link", { name: "Documentation" });
    // A plain anchor (server-served), not a client route.
    expect(docs.tagName).toBe("A");
    expect(docs.getAttribute("href")).toBe("/docs");
    // Docs is a separate server-rendered surface → open in a new tab, with a safe rel.
    expect(docs.getAttribute("target")).toBe("_blank");
    expect(docs.getAttribute("rel")).toBe("noreferrer");
  });

  it("the SPA defines no /docs route — /docs falls through to the dashboard 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "u1",
              email: "u@x",
              name: "U",
              avatarUrl: null,
              isAdmin: false,
              authMode: "dev",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    renderApp("/docs");
    // No client route owns /docs, so the SPA shows its 404 — the real /docs is
    // served by the server before the SPA ever loads.
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });

  it("shows the designed dashboard error state for route render failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rootRoute = createRootRoute({
      component: Outlet,
      errorComponent: DashboardRouteErrorState,
      notFoundComponent: DashboardNotFoundState,
    });
    const boomRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/boom",
      component: () => {
        throw new Error("render exploded");
      },
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([boomRoute]),
      history: createMemoryHistory({ initialEntries: ["/boom"] }),
      defaultErrorComponent: DashboardRouteErrorState,
      defaultNotFoundComponent: DashboardNotFoundState,
    });

    renderTestRouter(router);

    expect(
      await screen.findByRole("heading", { name: "Dashboard view failed" }),
    ).toBeInTheDocument();
    expect(screen.getByText("route_error")).toBeInTheDocument();
    expect(screen.getByText("render exploded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
