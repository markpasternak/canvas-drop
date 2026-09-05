import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AudienceCanvas, CanvasAudience } from "../components/CanvasAudience.js";

const base: AudienceCanvas = {
  id: "c1",
  access: "private",
  status: "active",
  currentVersionId: "v1",
  sharedExpiresAt: null,
  hasPassword: false,
  orgId: null,
};
async function show(
  overrides: Partial<AudienceCanvas> = {},
  orgs?: Array<{ id: string; name: string }>,
) {
  const root = createRootRoute({ component: Outlet });
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <CanvasAudience canvas={{ ...base, ...overrides }} orgs={orgs} />,
  });
  const share = createRoute({
    getParentRoute: () => root,
    path: "/canvases/$id/share",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([index, share]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: isolated test router
    render(<RouterProvider router={router as any} />);
    await router.load();
  });
}

afterEach(() => vi.useRealTimers());

describe("canvas link audience", () => {
  it.each(["private", "specific_people", "team"] as const)(
    "describes %s without inventing a grant count",
    async (access) => {
      await show({ access });
      expect(screen.getByText("Restricted to people and teams with access")).toBeInTheDocument();
      expect(screen.queryByText(/only you/i)).toBeNull();
      expect(screen.getByRole("link", { name: "People and teams" })).toHaveAttribute(
        "href",
        "/canvases/c1/share#people",
      );
    },
  );
  it("includes direct grants alongside the canvas's home organization", async () => {
    await show({ access: "whole_org", orgId: "o1" }, [{ id: "o1", name: "Acme" }]);
    expect(screen.getByText("Acme members, plus people and teams with access")).toBeInTheDocument();
  });
  it("does not imply org-wide access on an invalid Personal canvas under active tenancy", async () => {
    await show({ access: "whole_org" }, [{ id: "o1", name: "Acme" }]);
    expect(screen.getByText("Restricted to people and teams with access")).toBeInTheDocument();
  });
  it("does not claim Restricted while organization metadata is unavailable", async () => {
    await show({ access: "whole_org" });
    expect(
      screen.getByText("Organization access selected; availability hasn't been verified."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/restricted to people/i)).toBeNull();
  });
  it("describes workspace membership when tenancy is known to be inactive", async () => {
    await show({ access: "whole_org" }, []);
    expect(
      screen.getByText("Workspace members, plus people and teams with access"),
    ).toBeInTheDocument();
  });
  it.each([
    [true, "Anyone with the link"],
    [false, "Public sharing is paused; direct access still applies."],
    [undefined, "Public link selected; availability hasn't been verified."],
  ] as const)("reports public policy %s", async (publicLinkEnabled, text) => {
    await show({ access: "public_link", publicLinkEnabled });
    expect(screen.getByText(text)).toBeInTheDocument();
  });
  it("announces expiry at the boundary while preserving owner/editor access", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    await show({
      access: "public_link",
      publicLinkEnabled: true,
      hasPassword: true,
      sharedExpiresAt: Date.now() + 60_000,
    });
    expect(screen.getByText("Anyone with the link")).toBeInTheDocument();
    expect(screen.getByText("Password protection on")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });
    expect(
      screen.getByText("Viewer access has expired. Owners and editors can still open."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Anyone with the link")).toBeNull();
  });
  it.each(["archived", "disabled", "deleted"] as const)(
    "does not present %s as a usable link",
    async (status) => {
      await show({ status });
      expect(screen.getByText(/this link is offline/)).toBeInTheDocument();
      expect(screen.queryByRole("link")).toBeNull();
    },
  );
  it("explains why an unpublished URL cannot be shared yet", async () => {
    await show({ currentVersionId: null });
    expect(screen.getByText("Publish this draft before sharing its link.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
