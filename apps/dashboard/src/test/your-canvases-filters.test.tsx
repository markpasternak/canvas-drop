import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
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

function stub(canvases: Array<ReturnType<typeof canvas>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url, "http://localhost").pathname;
      const body =
        path === "/api/me"
          ? { id: "u1", email: "u@x", name: "U", avatarUrl: null, isAdmin: false, authMode: "dev" }
          : path.endsWith("/archived")
            ? { canvases: [] }
            : { canvases };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
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

describe("Your canvases — client-side filters (plan 004)", () => {
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

  it("searches by title", async () => {
    stub([
      canvas({ id: "a", title: "Quarterly revenue" }),
      canvas({ id: "b", title: "Team poll" }),
    ]);
    renderAt("/");
    await screen.findByText("Quarterly revenue");

    await userEvent.type(screen.getByRole("searchbox", { name: "Search your canvases" }), "poll");
    expect(await screen.findByText("Team poll")).toBeInTheDocument();
    expect(screen.queryByText("Quarterly revenue")).toBeNull();
  });

  it("composes filters and shows the filtered-empty state with Clear filters", async () => {
    stub([
      canvas({ id: "a", title: "Shared template", shared: true, galleryTemplatable: true }),
      canvas({ id: "b", title: "Plain shared", shared: true, galleryTemplatable: false }),
    ]);
    // shared AND template → only the first; then narrow further to never-deployed → none.
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

  it("keeps onboarding for a truly empty list (filters never trigger it)", async () => {
    stub([]);
    renderAt("/?shared=true");
    // Zero owned canvases → the onboarding/empty path, not the filtered-empty state.
    expect(await screen.findByText(/ship your first canvas/i)).toBeInTheDocument();
    expect(screen.queryByText("No canvases match these filters")).toBeNull();
  });
});
