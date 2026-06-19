import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

function renderOnboarding() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/onboarding"] }),
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

afterEach(() => vi.restoreAllMocks());

describe("onboarding — on-brand structure (U20)", () => {
  it("renders the creation paths inside a boxed, bordered panel", async () => {
    renderOnboarding();
    // The paths picker is a labeled region rendered as an on-brand boxed panel
    // (rounded border + surface), not a loose transparent list.
    const paths = await screen.findByRole("region", { name: /creation paths/i });
    expect(paths.className).toMatch(/rounded-xl/);
    expect(paths.className).toMatch(/border-border/);
    expect(paths.className).toMatch(/bg-surface/);
  });

  it("offers the three creation paths and the agent-snippet panel", async () => {
    renderOnboarding();
    expect(await screen.findByRole("button", { name: /paste/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /upload/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /get a key/i })).toBeInTheDocument();
    expect(screen.getByText(/build with an ai agent/i)).toBeInTheDocument();
  });
});
