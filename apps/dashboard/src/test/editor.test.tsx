import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

// Keep CodeMirror out of jsdom: a textarea stand-in that preserves the
// path/value/onChange contract the route depends on.
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
  currentVersionId: "v1",
  createdAt: 0,
  updatedAt: 0,
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

function renderEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/canvases/c1/editor"] }),
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

const draftView = (over: Partial<Record<string, unknown>> = {}) => ({
  files: [{ path: "index.html", size: 10, mime: "text/html" }],
  stale: false,
  baseVersionId: "v1",
  updatedAt: 0,
  dirty: false,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("Editor route", () => {
  it("lists draft files and loads the selected file's content", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView()),
      // Raw file content is plain text (HTML), not JSON.
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>hi</h1>", { status: 200 }),
    });
    renderEditor();
    expect(await screen.findByText("index.html")).toBeInTheDocument();
    const editor = await screen.findByTestId("code-editor");
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain("hi"));
  });

  it("shows the stale notice when a newer version was published under the draft", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView({ stale: true, dirty: true })),
      "GET /api/canvases/c1/draft/file": () => new Response("x", { status: 200 }),
    });
    renderEditor();
    expect(await screen.findByText(/newer version was published/i)).toBeInTheDocument();
    expect(screen.getByText(/unpublished changes/i)).toBeInTheDocument();
  });

  it("publishes the draft via the publish endpoint", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView({ dirty: true })),
      "GET /api/canvases/c1/draft/file": () => new Response("x", { status: 200 }),
      "POST /api/canvases/c1/publish": () =>
        json({ version: 2, versionId: "v2", fileCount: 1, totalBytes: 1 }),
    });
    renderEditor();
    const publishBtn = await screen.findByRole("button", { name: "Publish" });
    await userEvent.click(publishBtn);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/canvases/c1/publish")).toBe(
        true,
      ),
    );
  });

  it("pauses editing for a non-active canvas", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json({ ...CANVAS, status: "archived" }),
      "GET /api/canvases/c1/draft": () => json(draftView()),
    });
    renderEditor();
    expect(await screen.findByText(/editing is paused/i)).toBeInTheDocument();
  });
});
