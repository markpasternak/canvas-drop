import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

const base = {
  url: "http://x/c/s",
  title: "",
  description: null,
  sharedExpiresAt: null,
  spaFallback: false,
  galleryListed: false,
  gallerySummary: null,
  galleryTags: null,
  status: "active",
  disabledReason: null,
  currentVersionId: null,
  createdAt: 0,
  updatedAt: 0,
  lastDeploy: null,
};

function canvas(over: Record<string, unknown>) {
  return { ...base, ...over };
}

function summaryFor(canvases: unknown[]) {
  const rows = canvases as Array<Record<string, unknown>>;
  const activeRows = rows.filter((c) => c.status !== "archived" && c.status !== "deleted");
  return {
    active: activeRows.length,
    archived: rows.filter((c) => c.status === "archived").length,
    shared: activeRows.filter((c) => c.shared).length,
    protected: activeRows.filter((c) => c.hasPassword).length,
    listed: activeRows.filter((c) => c.galleryListed).length,
    templates: activeRows.filter((c) => c.galleryTemplatable).length,
    neverDeployed: activeRows.filter((c) => c.lastDeploy === null).length,
  };
}

function renderListWith(canvases: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url, "http://localhost").pathname;
      if (path === "/api/me") {
        return new Response(
          JSON.stringify({
            id: "u1",
            email: "u@example.com",
            name: "U",
            avatarUrl: null,
            isAdmin: false,
            authMode: "dev",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          canvases,
          total: canvases.length,
          limit: 24,
          offset: 0,
          summary: summaryFor(canvases),
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          {/* biome-ignore lint/suspicious/noExplicitAny: test router */}
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

describe("list row badges", () => {
  it("splits access state into the Visibility column instead of mixing every state badge", async () => {
    renderListWith([
      canvas({ id: "a", slug: "s-plain", title: "Plain one", shared: false, hasPassword: false }),
      canvas({ id: "b", slug: "s-shared", title: "Shared one", shared: true, hasPassword: false }),
      canvas({ id: "c", slug: "s-locked", title: "Locked one", shared: false, hasPassword: true }),
      canvas({ id: "d", slug: "s-both", title: "Both one", shared: true, hasPassword: true }),
    ]);
    await screen.findByText("Plain one"); // list rendered

    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(screen.getByText("Owner only")).toBeInTheDocument();
    expect(screen.getAllByText("Shared").length).toBeGreaterThan(1);
    expect(screen.getByText("Public link")).toBeInTheDocument();
    expect(screen.getAllByText("Protected").length).toBeGreaterThan(1);
    expect(screen.getByText("Password set")).toBeInTheDocument();
    expect(screen.getByText("Shared + protected")).toBeInTheDocument();
    expect(screen.getByText("Password required")).toBeInTheDocument();
  });

  it("surfaces draft-only deployment state, but not zeros for deployed canvases", async () => {
    renderListWith([
      canvas({
        id: "shipped",
        slug: "shipped",
        title: "Shipped one",
        lastDeploy: { version: 1, createdAt: 0, fileCount: 1, totalBytes: 10 },
      }),
      canvas({ id: "draft", slug: "draft", title: "Draft one" }), // base lastDeploy: null
    ]);
    await screen.findByText("Shipped one");
    expect(screen.getByText("Published v1")).toBeInTheDocument();
    expect(
      screen.getAllByText("Draft only").filter((el) => el.closest("button") === null).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("0 B")).toBeNull();
    expect(screen.queryByText("0 files")).toBeNull();
  });

  it("badges a disabled canvas (the one status worth surfacing)", async () => {
    renderListWith([
      canvas({ id: "x", slug: "down", status: "disabled", shared: false, hasPassword: false }),
    ]);
    expect(await screen.findByText("Disabled")).toBeInTheDocument();
  });

  it("renders inline tag pills, collapsing beyond the cap into a +N pill (plan 005)", async () => {
    renderListWith([
      canvas({
        id: "tagged",
        slug: "tagged",
        title: "Tagged one",
        galleryTags: ["alpha", "beta", "gamma", "delta", "epsilon"],
      }),
    ]);
    await screen.findByText("Tagged one");
    // First MAX_ROW_TAGS (3) render as pills; the remaining two collapse to +2.
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("gamma")).toBeInTheDocument();
    expect(screen.queryByText("delta")).toBeNull();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("separates gallery listing state from tags", async () => {
    renderListWith([
      canvas({
        id: "listed",
        slug: "listed",
        title: "Listed one",
        galleryListed: true,
        galleryTags: ["docs"],
      }),
      canvas({
        id: "unlisted",
        slug: "unlisted",
        title: "Unlisted one",
        galleryListed: false,
        galleryTags: ["internal"],
      }),
    ]);
    await screen.findByText("Listed one");

    expect(screen.getAllByText("Gallery").length).toBeGreaterThan(1);
    expect(screen.getByText("In gallery")).toBeInTheDocument();
    expect(screen.getByText("Hidden from gallery")).toBeInTheDocument();
    expect(screen.getByText("docs")).toBeInTheDocument();
    expect(screen.getByText("internal")).toBeInTheDocument();
  });

  it("limits the internal details click target to the title link", async () => {
    renderListWith([canvas({ id: "t", slug: "title-target", title: "Title target" })]);

    const detailsLink = await screen.findByRole("link", { name: "View details for Title target" });
    expect(detailsLink).toHaveAttribute("href", "/canvases/t");
    expect(detailsLink).toHaveTextContent("Title target");
    expect(screen.queryByRole("link", { name: "Open details for Title target" })).toBeNull();
  });

  it("shows no tag pills for an untagged canvas", async () => {
    renderListWith([canvas({ id: "u", slug: "untagged", title: "Untagged one" })]);
    await screen.findByText("Untagged one");
    expect(screen.getByText("No tags")).toBeInTheDocument();
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });
});
