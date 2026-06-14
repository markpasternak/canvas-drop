import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
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
});

describe("dashboard app", () => {
  it("renders the shell and, with zero canvases, the onboarding first-run page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ canvases: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    renderApp("/");
    // shell chrome
    expect(await screen.findByText("Canvasdrop")).toBeInTheDocument();
    // empty list → onboarding
    expect(await screen.findByText(/ship your first canvas/i)).toBeInTheDocument();
    expect(screen.getByText(/paste html/i)).toBeInTheDocument();
  });

  it("points at the Archived view when every canvas is archived (not onboarding)", async () => {
    const archivedItem = {
      id: "a1",
      slug: "old-otter",
      url: "http://x/c/old-otter",
      title: "Retired",
      description: null,
      shared: false,
      sharedExpiresAt: null,
      hasPassword: false,
      spaFallback: false,
      galleryListed: false,
      gallerySummary: null,
      galleryTags: null,
      status: "archived",
      disabledReason: null,
      currentVersionId: "v1",
      createdAt: 0,
      updatedAt: 0,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url, "http://localhost").pathname;
        const body = path.endsWith("/archived") ? { canvases: [archivedItem] } : { canvases: [] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
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
                  galleryListed: false,
                  gallerySummary: null,
                  galleryTags: null,
                  status: "active",
                  disabledReason: null,
                  currentVersionId: "v1",
                  createdAt: 0,
                  updatedAt: 0,
                  lastDeploy: { version: 1, createdAt: Date.now(), fileCount: 1, totalBytes: 10 },
                },
              ],
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
          new Response(JSON.stringify({ canvases: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    renderApp("/");
    await screen.findByText("Canvasdrop");
    const user = userEvent.setup();

    // Closed: only the (always-rendered) desktop nav has the Archived link.
    expect(screen.getAllByRole("link", { name: "Archived" })).toHaveLength(1);

    const toggle = screen.getByRole("button", { name: "Open menu" });
    await user.click(toggle);
    // Open: the mobile menu adds a second copy of each section link.
    expect(screen.getAllByRole("link", { name: "Archived" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Close menu" })).toBeInTheDocument();

    // Selecting a link in the menu closes it (back to the single desktop copy).
    const menuGallery = screen.getAllByRole("link", { name: "Gallery" }).at(-1);
    if (!menuGallery) throw new Error("expected a menu Gallery link");
    await user.click(menuGallery);
    expect(screen.getAllByRole("link", { name: "Archived" })).toHaveLength(1);
  });

  it("mobile menu: clicking the backdrop closes the menu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ canvases: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    renderApp("/");
    await screen.findByText("Canvasdrop");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getAllByRole("link", { name: "Archived" })).toHaveLength(2);

    // The backdrop is aria-hidden (out of the a11y tree), so target it by test id.
    await user.click(screen.getByTestId("menu-backdrop"));
    expect(screen.getAllByRole("link", { name: "Archived" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
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
      galleryListed: false,
      gallerySummary: null,
      galleryTags: null,
      status: "active",
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
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
