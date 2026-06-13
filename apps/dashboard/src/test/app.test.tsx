import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
