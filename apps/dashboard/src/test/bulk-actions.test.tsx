import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { useBulkArchive, useBulkDelete } from "../lib/mutations.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

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
    previewMode: "auto",
    galleryListed: false,
    galleryTemplatable: false,
    gallerySummary: null,
    galleryTags: null,
    status: "active",
    publicationState: "published",
    disabledReason: null,
    currentVersionId: "v1",
    createdAt: 0,
    updatedAt: 0,
    lastDeploy: { version: 1, createdAt: 0, fileCount: 1, totalBytes: 10 },
    ...over,
  };
}

interface Call {
  method: string;
  path: string;
}

/** Recording fetch: serves /api/me + the canvases list and records every lifecycle
 *  write. `fail` ids return 500 so partial-failure handling can be asserted. */
function recordingFetch(canvases: ReturnType<typeof canvas>[], fail: Set<string> = new Set()) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url, "http://localhost");
      const path = u.pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, path });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (path === "/api/me") {
        return json({ id: "u1", email: "u@x", name: "U", avatarUrl: null, isAdmin: false });
      }
      if (path === "/api/canvases" && method === "GET") {
        const active = canvases.filter((c) => c.status === "active");
        return json({
          canvases: active,
          total: active.length,
          limit: 24,
          offset: 0,
          summary: {
            active: active.length,
            archived: 0,
            shared: 0,
            protected: 0,
            listed: 0,
            templates: 0,
            neverDeployed: 0,
          },
        });
      }
      // Lifecycle writes: /api/canvases/:id[/archive|/unarchive]
      const id = path.split("/")[3];
      if (id && fail.has(id)) return json({ error: "boom" }, 500);
      return json({ ok: true });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bulk lifecycle mutations", () => {
  function wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  it("archives every selected id and reports them all succeeded", async () => {
    const calls = recordingFetch([], new Set());
    const { result } = renderHook(() => useBulkArchive(), { wrapper });
    const outcome = await result.current.mutateAsync(["a", "b", "c"]);

    expect(outcome.succeeded.sort()).toEqual(["a", "b", "c"]);
    expect(outcome.failed).toEqual([]);
    const archived = calls.filter((c) => c.method === "POST" && c.path.endsWith("/archive"));
    expect(archived.map((c) => c.path).sort()).toEqual([
      "/api/canvases/a/archive",
      "/api/canvases/b/archive",
      "/api/canvases/c/archive",
    ]);
  });

  it("splits succeeded vs failed on a partial failure", async () => {
    recordingFetch([], new Set(["b"]));
    const { result } = renderHook(() => useBulkDelete(), { wrapper });
    const outcome = await result.current.mutateAsync(["a", "b", "c"]);

    expect(outcome.succeeded.sort()).toEqual(["a", "c"]);
    expect(outcome.failed).toEqual(["b"]);
  });
});

function renderHome(canvases: ReturnType<typeof canvas>[]) {
  const calls = recordingFetch(canvases);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
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
  return calls;
}

describe("Your-canvases bulk selection", () => {
  it("selects rows, shows the bulk bar, and archives them on confirm", async () => {
    const user = userEvent.setup();
    renderHome([
      canvas({ id: "a", slug: "sa", title: "Alpha" }),
      canvas({ id: "b", slug: "sb", title: "Beta" }),
    ]);
    await screen.findByText("Alpha");

    await user.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Beta" }));
    expect(screen.getByText("2 canvases selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Archive" }));
    // Confirm dialog gates the batch.
    await user.click(await screen.findByRole("button", { name: "Archive 2 canvases" }));

    // Bar clears once the batch settles with no failures.
    await waitFor(() => expect(screen.queryByText("2 canvases selected")).not.toBeInTheDocument());
  });

  it("select-all selects the page and Clear empties it", async () => {
    const user = userEvent.setup();
    renderHome([
      canvas({ id: "a", slug: "sa", title: "Alpha" }),
      canvas({ id: "b", slug: "sb", title: "Beta" }),
    ]);
    await screen.findByText("Alpha");

    await user.click(screen.getByRole("checkbox", { name: "Select all canvases on this page" }));
    expect(screen.getByText("2 canvases selected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText("2 canvases selected")).not.toBeInTheDocument();
  });

  it("gates bulk delete behind a hold-to-confirm dialog", async () => {
    const user = userEvent.setup();
    const calls = renderHome([canvas({ id: "a", slug: "sa", title: "Alpha" })]);
    await screen.findByText("Alpha");

    await user.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    // A hold-to-confirm button appears; nothing is deleted on the open alone.
    expect(await screen.findByRole("button", { name: /Delete 1 canvas/ })).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
