import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

const CANVAS_ID = "0190a1b2-c3d4-7e5f-8a90-1b2c3d4e5f60";

const CANVAS = {
  id: CANVAS_ID,
  slug: "quiet-otter",
  slugCustom: true,
  url: "http://x/c/quiet-otter",
  hasPreview: false,
  title: "My Canvas",
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
  capabilities: { kv: true, files: true, ai: true, realtime: true },
  effective: { identity: false, kv: false, files: false, ai: false, realtime: false },
  status: "active",
  publicationState: "published" as string,
  disabledReason: null as string | null,
  currentVersionId: "v1" as string | null,
  createdAt: 0,
  updatedAt: 0,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch mock that knows the canvas by its id + slug; unknown ids/slugs 404. */
function mockFetch(knownSlug: string | null) {
  const calls: { method: string; url: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url, "http://localhost").pathname;
      calls.push({ method, url: path });
      if (path === `/api/canvases/${CANVAS_ID}`) return json(CANVAS);
      if (path === `/api/canvases/${CANVAS_ID}/versions`) return json({ versions: [] });
      if (path.startsWith("/api/canvases/by-slug/")) {
        const slug = decodeURIComponent(path.slice("/api/canvases/by-slug/".length));
        if (knownSlug && slug === knownSlug) return json({ id: CANVAS_ID });
        return json({ error: "not_found" }, 404);
      }
      // Any getCanvas by a non-id (slug) path 404s, as the server would.
      if (path.startsWith("/api/canvases/")) return json({ error: "not_found" }, 404);
      return json({ error: "not_mocked" }, 500);
    }),
  );
  return calls;
}

function renderAt(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initial] }),
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
  return router;
}

afterEach(() => vi.unstubAllGlobals());

describe("slug-aware canvas lookup (U17)", () => {
  it("redirects a slug URL to the canonical id route", async () => {
    const calls = mockFetch("quiet-otter");
    const router = renderAt("/canvases/quiet-otter");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/canvases/${CANVAS_ID}`);
    });
    // The canonical canvas loaded after the redirect.
    expect((await screen.findAllByText("My Canvas")).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.url === "/api/canvases/by-slug/quiet-otter")).toBe(true);
  });

  it("preserves the sub-route when redirecting a slug URL", async () => {
    mockFetch("quiet-otter");
    const router = renderAt("/canvases/quiet-otter/share");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/canvases/${CANVAS_ID}/share`);
    });
  });

  it("shows not-found for an unknown slug (no redirect)", async () => {
    mockFetch(null);
    const router = renderAt("/canvases/no-such-slug");

    expect(await screen.findByText("Canvas not found")).toBeInTheDocument();
    // Never navigated away from the bad slug URL.
    expect(router.state.location.pathname).toBe("/canvases/no-such-slug");
  });

  it("does not attempt a slug lookup for a uuid-shaped id", async () => {
    const calls = mockFetch("quiet-otter");
    renderAt(`/canvases/${CANVAS_ID}`);

    expect((await screen.findAllByText("My Canvas")).length).toBeGreaterThan(0);
    // The id path was loaded directly; no by-slug resolution fired.
    expect(calls.some((c) => c.url.startsWith("/api/canvases/by-slug/"))).toBe(false);
  });
});
