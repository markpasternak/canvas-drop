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
  previewMode: "auto",
  galleryListed: false,
  gallerySummary: null,
  tags: null,
  status: "active",
  publicationState: "draft",
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

function renderListWith(canvases: unknown[], initialPath = "/") {
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
    history: createMemoryHistory({ initialEntries: [initialPath] }),
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
  it("shows the access rung on the row's meta line, distinctly flagging Public", async () => {
    renderListWith([
      canvas({ id: "a", slug: "s-priv", title: "Private one", access: "private", shared: false }),
      canvas({ id: "b", slug: "s-org", title: "Org one", access: "whole_org", shared: true }),
      canvas({
        id: "c",
        slug: "s-people",
        title: "People one",
        access: "specific_people",
        shared: true,
      }),
      canvas({ id: "d", slug: "s-pub", title: "Public one", access: "public_link", shared: true }),
      canvas({
        id: "e",
        slug: "s-prot",
        title: "Protected one",
        access: "whole_org",
        shared: true,
        hasPassword: true,
      }),
    ]);
    await screen.findByText("Private one"); // list rendered

    // Visibility now rides the quiet meta line (the access "primary"), not a dedicated
    // column. The protected-on-org primary is unique to the row (not a filter option).
    expect(screen.getByText(/Whole org \+ protected/)).toBeInTheDocument();
    // Public is the only beyond-the-org rung: a distinct near-title pill PLUS the access
    // filter option, so it appears at least twice.
    expect(screen.getAllByText("Public").length).toBeGreaterThan(1);
    // The old Visibility column's secondary lines are gone.
    expect(screen.queryByText("Owner only")).toBeNull();
    expect(screen.queryByText("Anyone with the link")).toBeNull();
    expect(screen.queryByText("Password required")).toBeNull();
  });

  it("surfaces draft-only deployment state, but not zeros for deployed canvases", async () => {
    renderListWith([
      canvas({
        id: "shipped",
        slug: "shipped",
        title: "Shipped one",
        publicationState: "published",
        lastDeploy: { version: 1, createdAt: 0, fileCount: 1, totalBytes: 10 },
      }),
      canvas({ id: "draft", slug: "draft", title: "Draft one" }), // base: draft, lastDeploy null
    ]);
    await screen.findByText("Shipped one");
    // Deployed: the "Published" stat column carries the live version + footprint.
    expect(screen.getByText("v1")).toBeInTheDocument();
    // The draft row reads "Draft" in a near-title chip.
    expect(screen.getAllByText("Draft").length).toBeGreaterThan(0);
    expect(screen.queryByText("0 B")).toBeNull();
    expect(screen.queryByText("0 files")).toBeNull();
  });

  it("badges a disabled canvas (the one status worth surfacing)", async () => {
    renderListWith([
      canvas({
        id: "x",
        slug: "down",
        status: "disabled",
        publicationState: "disabled",
        shared: false,
        hasPassword: false,
      }),
    ]);
    // "Disabled" shows in the near-title chip and the Publication column.
    expect((await screen.findAllByText("Disabled")).length).toBeGreaterThan(0);
  });

  it("renders inline tag pills, collapsing beyond the cap into a +N pill (plan 005)", async () => {
    renderListWith([
      canvas({
        id: "tagged",
        slug: "tagged",
        title: "Tagged one",
        tags: ["alpha", "beta", "gamma", "delta", "epsilon"],
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

  it("surfaces gallery listing as a near-title badge, separate from tags", async () => {
    renderListWith([
      canvas({
        id: "listed",
        slug: "listed",
        title: "Listed one",
        galleryListed: true,
        tags: ["docs"],
      }),
      canvas({
        id: "unlisted",
        slug: "unlisted",
        title: "Unlisted one",
        galleryListed: false,
        tags: ["internal"],
      }),
    ]);
    await screen.findByText("Listed one");

    // Listing state is a near-title badge now (no dedicated Gallery column). "Listed"
    // also appears as a filter chip, so it shows more than once.
    expect(screen.getAllByText("Listed").length).toBeGreaterThan(1);
    // The old Gallery column's secondary lines are gone.
    expect(screen.queryByText("In gallery")).toBeNull();
    expect(screen.queryByText("Hidden from gallery")).toBeNull();
    // Tags still render as pills, independent of listing state.
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
    // Untagged rows simply omit the tag row now — no "No tags" placeholder, no +N pill.
    expect(screen.queryByText("No tags")).toBeNull();
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });

  it("renders the grid layout when ?view=grid (cover cards, no list stat columns)", async () => {
    renderListWith(
      [
        canvas({
          id: "g",
          slug: "g",
          title: "Gridded one",
          publicationState: "published",
          lastDeploy: { version: 2, createdAt: 0, fileCount: 1, totalBytes: 10 },
        }),
      ],
      "/?view=grid",
    );
    await screen.findByText("Gridded one");
    // Cards overlay the publication state on the cover (shown for every state, unlike
    // the list row which only badges the non-happy-path states).
    expect(screen.getByText("Published")).toBeInTheDocument();
    // ...but the grid drops the list's right-aligned "Created" stat column.
    expect(screen.queryByText("Created")).toBeNull();
    // Bulk selection still works in the grid (per-card checkbox + the select-all control).
    expect(
      screen.getByRole("checkbox", { name: "Select all canvases on this page" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Gridded one" })).toBeInTheDocument();
  });
});
