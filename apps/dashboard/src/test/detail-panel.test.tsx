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
import { DetailPanel } from "../components/DetailPanel.js";
import type { CanvasListItem } from "../lib/api.js";

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
  gallerySummary: null,
  galleryTags: null,
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
