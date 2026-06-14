import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

// Keep CodeMirror out of jsdom: the Editor route is navigated to after a restore,
// so a textarea stand-in keeps the editor mountable without the real CodeMirror.
vi.mock("../components/CodeEditor.js", () => ({
  CodeEditor: ({
    value,
    onChange,
  }: {
    path: string;
    value: string;
    onChange: (n: string) => void;
  }) => (
    <textarea data-testid="code-editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const CANVAS = {
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
  publicationState: "published",
  disabledReason: null,
  currentVersionId: "v1",
  createdAt: 0,
  updatedAt: 0,
};

const VERSION = {
  number: 1,
  source: "deploy",
  status: "ready",
  createdBy: "u1",
  createdAt: 0,
  fileCount: 1,
  totalBytes: 10,
  current: true,
  entry: { path: "index.html", reason: "index" },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handlers: Record<string, (init?: RequestInit) => Response>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = new URL(url, "http://localhost");
    const key = `${method} ${u.pathname}`;
    calls.push({ method, url: u.pathname + u.search, body: init?.body as string | undefined });
    const handler = handlers[key];
    if (handler) return handler(init);
    return json({ error: "not_mocked" }, 500);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const draftView = (over: Partial<Record<string, unknown>> = {}) => ({
  files: [{ path: "index.html", size: 10, mime: "text/html" }],
  stale: false,
  baseVersionId: "v1",
  updatedAt: 0,
  dirty: false,
  ...over,
});

function renderVersions() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/canvases/c1/versions"] }),
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

describe("Versions route — restore to draft", () => {
  it("restores directly (no confirm) when the draft is clean", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/versions": () => json({ versions: [VERSION] }),
      "GET /api/canvases/c1/draft": () => json(draftView({ dirty: false })),
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>hi</h1>", { status: 200 }),
      "POST /api/canvases/c1/restore": () => json(draftView()),
    });
    renderVersions();

    const restore = await screen.findByRole("button", { name: /restore to draft/i });
    await userEvent.click(restore);

    // No destructive confirm dialog is shown for a clean draft.
    expect(
      screen.queryByRole("button", { name: /restore and discard changes/i }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/restore"))).toBe(true),
    );
  });

  it("shows the destructive confirm when the draft is dirty, and restores + navigates on confirm", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/versions": () => json({ versions: [VERSION] }),
      "GET /api/canvases/c1/draft": () => json(draftView({ dirty: true })),
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>hi</h1>", { status: 200 }),
      "POST /api/canvases/c1/restore": () => json(draftView()),
    });
    const router = renderVersions();

    const restore = await screen.findByRole("button", { name: /restore to draft/i });
    await userEvent.click(restore);

    // Dirty draft → destructive confirm dialog, no restore call yet.
    const confirm = await screen.findByRole("button", { name: /restore and discard changes/i });
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/restore"))).toBe(false);

    await userEvent.click(confirm);

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/restore"))).toBe(true),
    );
    // Confirming navigates to the editor.
    await waitFor(() => expect(router.state.location.pathname).toBe("/canvases/c1/editor"));
  });
});
