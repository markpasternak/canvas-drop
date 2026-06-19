import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { CanvasDetailChrome } from "../components/CanvasDetail.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { ToastProvider } from "../components/Toast.js";
import type { CanvasListItem } from "../lib/api.js";
import { ThemeProvider } from "../lib/theme.js";

const base: CanvasListItem = {
  id: "cv-1",
  slug: "my-slug",
  slugCustom: false,
  url: "http://x/c/my-slug",
  hasPreview: false,
  title: "Three.js demo",
  description: null,
  access: "whole_org",
  shared: true,
  guestAiEnabled: false,
  guestAiCap: 0,
  sharedExpiresAt: null,
  hasPassword: false,
  spaFallback: false,
  previewMode: "auto",
  galleryListed: false,
  galleryTemplatable: false,
  tags: null,
  clonedFromCanvasId: null,
  backendEnabled: false,
  capabilities: { kv: false, files: false, ai: false, realtime: false },
  effective: { kv: false, files: false, ai: false, realtime: false, identity: true },
  status: "active",
  publicationState: "published",
  disabledReason: null,
  currentVersionId: "v-1",
  viewCount: 0,
  lastViewedAt: null,
  createdAt: Date.UTC(2024, 0, 1),
  updatedAt: Date.UTC(2024, 0, 2),
  recentViews: 0,
  lastDeploy: { version: 3, createdAt: Date.UTC(2024, 0, 2), fileCount: 4, totalBytes: 12_000 },
};

function canvas(over: Partial<CanvasListItem>): CanvasListItem {
  return { ...base, ...over };
}

/** Render a fragment inside a memory router that owns the routes the panel links
 *  to, so the `<Link>` hrefs resolve without pulling in the full app router. */
function renderInRouter(node: ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{node}</>,
  });
  const idRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/canvases/$id",
    component: Outlet,
  });
  const shareRoute = createRoute({
    getParentRoute: () => idRoute,
    path: "share",
    component: () => null,
  });
  const editorRoute = createRoute({
    getParentRoute: () => idRoute,
    path: "editor",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, idRoute.addChildren([shareRoute, editorRoute])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: test router instance
  render(<RouterProvider router={router as any} />);
}

describe("DetailPanel (plan P4 / U2)", () => {
  it("renders title, status, access and dates for a deployed canvas", async () => {
    renderInRouter(<DetailPanel canvas={canvas({})} />);
    expect(await screen.findByRole("heading", { name: "Three.js demo" })).toBeInTheDocument();
    // Publication + access badges.
    expect(screen.getAllByText("Published").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Whole org").length).toBeGreaterThan(0);
    // Details list facts.
    expect(screen.getByText("Access")).toBeInTheDocument();
    expect(screen.getByText("Visibility")).toBeInTheDocument();
    expect(screen.getByText("Edited")).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
    // Recent activity derives from the last deploy.
    expect(screen.getByText(/Published v3/)).toBeInTheDocument();
  });

  it("Open links to the canvas url and opens in a new tab", async () => {
    renderInRouter(<DetailPanel canvas={canvas({})} />);
    const open = await screen.findByRole("link", { name: "Open Three.js demo" });
    expect(open).toHaveAttribute("href", "http://x/c/my-slug");
    expect(open).toHaveAttribute("target", "_blank");
  });

  it("Share links to the share route", async () => {
    renderInRouter(<DetailPanel canvas={canvas({})} />);
    const share = await screen.findByRole("link", { name: "Share Three.js demo" });
    expect(share).toHaveAttribute("href", "/canvases/cv-1/share");
  });

  it("renders the empty state when canvas is null", async () => {
    renderInRouter(<DetailPanel canvas={null} />);
    expect(await screen.findByText("Select a canvas to see details.")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("shows Continue setup (not Open) for a never-deployed canvas", async () => {
    renderInRouter(
      <DetailPanel canvas={canvas({ lastDeploy: null, publicationState: "draft" })} />,
    );
    const setup = await screen.findByRole("link", { name: "Continue setup for Three.js demo" });
    expect(setup).toHaveAttribute("href", "/canvases/cv-1/editor");
    expect(screen.queryByRole("link", { name: "Open Three.js demo" })).toBeNull();
  });

  it("wraps content in a labelled details region", async () => {
    renderInRouter(<DetailPanel canvas={canvas({})} />);
    expect(
      await screen.findByRole("complementary", { name: "Canvas details" }),
    ).toBeInTheDocument();
  });
});

/** A minimal router carrying every route the CanvasDetailChrome TabNav links to, so
 *  the header's `<Link>`s resolve without the full app router. */
function renderChrome(node: ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{node}</>,
  });
  const idRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/canvases/$id",
    component: Outlet,
  });
  const tabPaths = ["/", "editor", "share", "versions", "capabilities", "usage", "settings"];
  const tabRoutes = tabPaths.map((path) =>
    createRoute({ getParentRoute: () => idRoute, path, component: () => null }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, idRoute.addChildren(tabRoutes)]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <ThemeProvider>
      <ToastProvider>
        {/* biome-ignore lint/suspicious/noExplicitAny: test router instance */}
        <RouterProvider router={router as any} />
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe("CanvasDetailChrome (draft branch)", () => {
  it("reframes a draft around 'not live yet' and does NOT present the public URL as a live link", async () => {
    renderChrome(
      <CanvasDetailChrome id="cv-1" title="My Draft" url="http://x/c/my-slug" draft={true} />,
    );

    // The draft lifecycle note is shown…
    expect(await screen.findByText(/not live yet/i)).toBeInTheDocument();
    // …and the public URL is NOT dangled as a live, reachable affordance.
    expect(screen.queryByRole("link", { name: "http://x/c/my-slug" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open live canvas" })).toBeNull();
  });

  it("a published (non-draft) canvas shows the live URL link and no draft framing", async () => {
    renderChrome(
      <CanvasDetailChrome id="cv-1" title="My Canvas" url="http://x/c/my-slug" draft={false} />,
    );

    expect(await screen.findByRole("link", { name: "Open live canvas" })).toHaveAttribute(
      "href",
      "http://x/c/my-slug",
    );
    expect(screen.queryByText(/not live yet/i)).toBeNull();
  });
});
