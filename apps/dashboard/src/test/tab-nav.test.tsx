import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TabNav, type TabNavItem } from "../components/TabNav.js";

const ITEMS: ReadonlyArray<TabNavItem> = [
  { to: "/admin", label: "Overview", end: true },
  { to: "/admin/canvases", label: "Canvases" },
  { to: "/admin/users", label: "Users" },
];

/**
 * TabNav renders TanStack `<Link>`s, which need a router context. Build a tiny tree
 * that hosts the nav on every matched route so we can drive the active state by URL.
 */
function renderAt(initialPath: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <TabNav items={ITEMS} aria-label="Admin sections" />
        <Outlet />
      </>
    ),
  });
  const make = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
  const routeTree = rootRoute.addChildren([
    make("/admin"),
    make("/admin/canvases"),
    make("/admin/users"),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  render(
    // biome-ignore lint/suspicious/noExplicitAny: test router instance
    <RouterProvider router={router as any} />,
  );
}

describe("TabNav", () => {
  it("renders a labelled nav with one link per item pointing at the right routes", async () => {
    renderAt("/admin");
    const nav = await screen.findByRole("navigation", { name: "Admin sections" });
    expect(within(nav).getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/admin");
    expect(within(nav).getByRole("link", { name: "Canvases" })).toHaveAttribute(
      "href",
      "/admin/canvases",
    );
    expect(within(nav).getByRole("link", { name: "Users" })).toHaveAttribute(
      "href",
      "/admin/users",
    );
  });

  it("marks the active tab with aria-current=page", async () => {
    renderAt("/admin/canvases");
    const nav = await screen.findByRole("navigation", { name: "Admin sections" });
    expect(within(nav).getByRole("link", { name: "Canvases" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Users" })).not.toHaveAttribute("aria-current");
  });

  it("treats an `end` tab as exact (Overview is not active on a child route)", async () => {
    renderAt("/admin/users");
    const nav = await screen.findByRole("navigation", { name: "Admin sections" });
    // Overview (end:true) must not light up just because the path starts with /admin.
    expect(within(nav).getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
    expect(within(nav).getByRole("link", { name: "Users" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
