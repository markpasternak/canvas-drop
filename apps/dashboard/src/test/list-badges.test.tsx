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
  currentVersionId: null,
  createdAt: 0,
  updatedAt: 0,
  lastDeploy: null,
};

function canvas(over: Record<string, unknown>) {
  return { ...base, ...over };
}

function renderListWith(canvases: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ canvases }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
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

afterEach(() => vi.restoreAllMocks());

describe("list row badges", () => {
  it("shows Shared / Protected pills per state and never the boring 'Active'", async () => {
    renderListWith([
      canvas({ id: "a", slug: "s-plain", title: "Plain one", shared: false, hasPassword: false }),
      canvas({ id: "b", slug: "s-shared", title: "Shared one", shared: true, hasPassword: false }),
      canvas({ id: "c", slug: "s-locked", title: "Locked one", shared: false, hasPassword: true }),
      canvas({ id: "d", slug: "s-both", title: "Both one", shared: true, hasPassword: true }),
    ]);
    await screen.findByText("Plain one"); // list rendered

    expect(screen.getAllByText("Shared")).toHaveLength(2); // shared + both
    expect(screen.getAllByText("Protected")).toHaveLength(2); // locked + both
    expect(screen.queryByText("Active")).not.toBeInTheDocument(); // active is implicit
  });

  it("badges a disabled canvas (the one status worth surfacing)", async () => {
    renderListWith([
      canvas({ id: "x", slug: "down", status: "disabled", shared: false, hasPassword: false }),
    ]);
    expect(await screen.findByText("Disabled")).toBeInTheDocument();
  });
});
