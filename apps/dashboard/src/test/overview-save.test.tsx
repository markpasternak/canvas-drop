import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

// A published canvas with a known server-truth title/description/tags. The Overview
// Basics section seeds its local title/description/tags state from these.
const CANVAS = {
  id: "c1",
  slug: "quiet-otter",
  url: "http://x/c/quiet-otter",
  title: "Server Title",
  description: "Server description",
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
  tags: ["alpha"],
  clonedFromCanvasId: null,
  status: "active",
  publicationState: "published",
  disabledReason: null,
  currentVersionId: "v1",
  createdAt: 0,
  updatedAt: 0,
};

const VERSION = {
  number: 1,
  source: "folder",
  status: "ready",
  createdBy: "u1",
  createdAt: 1_700_000_000_000,
  fileCount: 2,
  totalBytes: 2048,
  current: true,
  entry: { path: "index.html", reason: "index" },
};

const ME = {
  id: "u1",
  email: "owner@example.com",
  name: "Owner",
  avatarUrl: null,
  isAdmin: false,
  canPublishPublic: false,
  authMode: "dev",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handlers: Record<string, () => Response>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const defaults: Record<string, () => Response> = {
    "GET /api/me": () => json(ME),
    "GET /api/canvases/c1": () => json(CANVAS),
    "GET /api/canvases/c1/versions": () => json({ versions: [VERSION] }),
  };
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url, "http://localhost").pathname;
    calls.push({ method, url: path, body: init?.body as string | undefined });
    const handler = handlers[`${method} ${path}`] ?? defaults[`${method} ${path}`];
    if (handler) return handler();
    return json({ error: "not_mocked" }, 500);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function renderOverview() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/canvases/c1"] }),
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

describe("Overview Basics save — optimistic-divergence recovery", () => {
  it("reverts the title input AND shows an error toast when the PATCH fails", async () => {
    mockFetch({
      "PATCH /api/canvases/c1/settings": () =>
        json({ code: "VALIDATION", message: "That title is not allowed." }, 422),
    });
    const user = userEvent.setup();
    renderOverview();

    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(title.value).toBe("Server Title");

    // Edit then blur to trigger the save; the server rejects it.
    await user.clear(title);
    await user.type(title, "Rejected Title");
    expect(title.value).toBe("Rejected Title");
    title.blur();

    // The save surfaces the failure as an error toast (no silent swallow)...
    expect(await screen.findByText(/that title is not allowed/i)).toBeInTheDocument();
    // ...and the local input snaps back to the server-truth value (not the rejected edit).
    await vi.waitFor(() => expect(title.value).toBe("Server Title"));
  });

  it("reverts the TagsEditor to server tags when the PATCH fails", async () => {
    mockFetch({
      "PATCH /api/canvases/c1/settings": () =>
        json({ code: "VALIDATION", message: "Could not save the tags." }, 422),
    });
    const user = userEvent.setup();
    renderOverview();

    // Server-truth tag is present.
    const tagList = await screen.findByRole("list", { name: /current tags/i });
    expect(within(tagList).getByText("alpha")).toBeInTheDocument();

    // Add a tag via Enter → optimistic render, then the server rejects the write.
    const tagInput = screen.getByLabelText("Tags");
    await user.type(tagInput, "beta{Enter}");

    // The error toast fires...
    expect(await screen.findByText(/could not save the tags/i)).toBeInTheDocument();
    // ...and the TagsEditor reverts to the server vocabulary: the rejected tag is gone,
    // the original stays.
    await vi.waitFor(() => {
      const list = screen.getByRole("list", { name: /current tags/i });
      expect(within(list).queryByText("beta")).toBeNull();
      expect(within(list).getByText("alpha")).toBeInTheDocument();
    });
  });
});
