import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import type { GalleryItem } from "../lib/api.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const templatableItem: GalleryItem = {
  id: "src-1",
  slug: "src-slug",
  url: "http://x/c/src-slug",
  title: "Starter kit",
  summary: null,
  tags: [],
  templatable: true,
  publishedAt: 1,
  owner: { id: "u-alice", name: "alice", avatarUrl: null },
};

function renderGallery() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/gallery"] }),
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

describe("Clone from the gallery (plan 002 U7)", () => {
  it("Make a copy → confirm → POSTs the clone endpoint for the source", async () => {
    const cloneCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = new URL(url, "http://localhost");
        if (u.pathname === "/api/gallery") {
          return json({ items: [templatableItem], total: 1, limit: 24, offset: 0 });
        }
        if (u.pathname === "/api/canvases/src-1/clone" && init?.method === "POST") {
          cloneCalls.push(u.pathname);
          return json({ id: "new-1", slug: "new-slug", apiKey: "cd_x" }, 201);
        }
        // The post-clone navigation loads the new canvas — stub it loosely.
        return json({ id: "new-1" });
      }),
    );

    renderGallery();

    // Card action opens the confirm dialog.
    await userEvent.click(await screen.findByRole("button", { name: "Make a copy" }));
    // The dialog's own "Make a copy" button fires the clone (scope to the dialog to
    // disambiguate from the card's button).
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Make a copy" }));

    await waitFor(() => expect(cloneCalls).toEqual(["/api/canvases/src-1/clone"]));
  });
});
