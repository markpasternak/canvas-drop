import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

/**
 * Regression: opening a Dialog (Add file / Rename) while the editor has a LIVE
 * CodeMirror editor mounted must not freeze the tab.
 *
 * The bug: Dialog's focus-trap + body-overflow effect depended on `onClose` (a fresh
 * arrow every parent render), so it re-ran on every render. With a live CodeMirror
 * underneath, the repeated focus/overflow toggling drove CodeMirror into an infinite
 * SYNCHRONOUS measure loop — the whole tab locked up. (Fixed by stabilising the
 * effect to depend only on `[open]`.)
 *
 * Crucially this test does NOT mock CodeEditor — the rest of the editor suite mocks
 * CodeMirror out of jsdom, which is exactly what hid this bug. If the loop regresses,
 * this test hangs until the per-test timeout instead of passing in ~half a second.
 */

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
  previewMode: "auto",
  galleryListed: false,
  tags: null,
  status: "active",
  publicationState: "published",
  disabledReason: null,
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

const draftView = {
  files: [{ path: "index.html", size: 10, mime: "text/html" }],
  stale: false,
  baseVersionId: "v1",
  updatedAt: 0,
  dirty: false,
};

function mockFetch() {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://localhost");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${u.pathname}`;
    if (key === "GET /api/canvases/c1") return json(CANVAS);
    if (key === "GET /api/canvases/c1/draft") return json(draftView);
    if (key === "GET /api/canvases/c1/draft/file")
      return new Response("<h1>x</h1>", { status: 200 });
    return json({ error: "not_mocked" }, 500);
  });
  vi.stubGlobal("fetch", fn);
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

afterEach(() => vi.unstubAllGlobals());

describe("editor: dialogs over a live CodeMirror editor don't freeze", () => {
  it("opens the Add-file dialog without locking up", async () => {
    mockFetch();
    renderEditor();
    await screen.findByText("index.html"); // real CodeMirror mounts for index.html
    await userEvent.click(await screen.findByRole("button", { name: "Add file" }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText("e.g. styles/main.css")).toBeInTheDocument(),
    );
  });

  it("opens the Rename dialog without locking up", async () => {
    mockFetch();
    renderEditor();
    await screen.findByText("index.html");
    await userEvent.click(await screen.findByRole("button", { name: "Rename file" }));
    await waitFor(() => expect(screen.getByText("Rename file")).toBeInTheDocument());
  });
});
