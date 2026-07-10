import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  const utils = render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          {/* biome-ignore lint/suspicious/noExplicitAny: test router instance */}
          <RouterProvider router={router as any} />
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { router, ...utils };
}

afterEach(() => vi.unstubAllGlobals());

describe("Versions route — redesigned rows + make current", () => {
  it("renders a balanced bordered row (current flagged) and still switches the current version", async () => {
    const v1 = { ...VERSION, number: 1, current: true };
    const v2 = { ...VERSION, number: 2, current: false };
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      // Newest first: v2 (current candidate) then v1 (current now).
      "GET /api/canvases/c1/versions": () => json({ versions: [v2, v1] }),
      "GET /api/canvases/c1/draft": () => json(draftView({ dirty: false })),
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>hi</h1>", { status: 200 }),
      "POST /api/canvases/c1/rollback": () => json({ ok: true }),
    });
    renderVersions();

    // Redesigned rows: each version is a bordered list-row carrying its identity,
    // the current one flagged with the Current badge on its primary line.
    const v1Label = await screen.findByText("v1");
    const row = v1Label.closest("li") as HTMLElement;
    expect(row.className).toMatch(/border/);
    expect(row.className).toMatch(/rounded-lg/);
    expect(within(row).getByText("Current")).toBeInTheDocument();

    // Make-current on the non-current version still drives the rollback flow:
    // the row button opens the confirm dialog, whose action issues the rollback.
    await userEvent.click(screen.getByRole("button", { name: "Make current" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Make current" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/rollback"))).toBe(true),
    );
  });
});

describe("Versions route — restore to draft", () => {
  it("restores directly (no confirm) when the draft is clean", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/versions": () => json({ versions: [VERSION] }),
      "GET /api/canvases/c1/draft": () => json(draftView({ dirty: false })),
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>hi</h1>", { status: 200 }),
      "POST /api/canvases/c1/restore": () => json(draftView()),
    });
    const { container } = renderVersions();

    // Wait for the version rows, then assert the flat redesign (U3): version rows live
    // in a hairline-divided list, not boxed Panel cards.
    expect(await screen.findByText("v1")).toBeInTheDocument();
    expect(container.querySelector(".rounded-xl")).toBeNull();

    await userEvent.click(await screen.findByRole("button", { name: "Restore" }));

    // No destructive confirm dialog is shown for a clean draft.
    expect(
      screen.queryByRole("button", { name: /load and discard changes/i }),
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
    const { router } = renderVersions();

    await userEvent.click(await screen.findByRole("button", { name: "Restore" }));

    // Dirty draft → destructive confirm dialog, no restore call yet.
    const confirm = await screen.findByRole("button", { name: /load and discard changes/i });
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/restore"))).toBe(false);

    await userEvent.click(confirm);

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/restore"))).toBe(true),
    );
    // Confirming navigates to the editor.
    await waitFor(() => expect(router.state.location.pathname).toBe("/canvases/c1/editor"));
  });
});

describe("Versions route — direct download and safe delete", () => {
  it("shows direct actions and deletes only a non-current version after confirmation", async () => {
    const current = { ...VERSION, number: 2, current: true };
    const historical = { ...VERSION, number: 1, current: false };
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json({ ...CANVAS, currentVersionId: "v2" }),
      "GET /api/canvases/c1/versions": () => json({ versions: [current, historical] }),
      "GET /api/canvases/c1/draft": () => json(draftView()),
      "DELETE /api/canvases/c1/versions/1": () => json({ ok: true, version: 1 }),
    });
    renderVersions();

    const currentRow = (await screen.findByText("v2")).closest("li") as HTMLElement;
    const historicalRow = screen.getByText("v1").closest("li") as HTMLElement;
    expect(within(currentRow).getByRole("link", { name: "Download ZIP" })).toHaveAttribute(
      "href",
      "/api/canvases/c1/versions/2/download",
    );
    expect(within(currentRow).getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(within(currentRow).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(currentRow).getByText(/current version can't be deleted/i)).toBeInTheDocument();

    await userEvent.click(within(historicalRow).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/permanently removes version 1/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete version" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === "DELETE" && call.url === "/api/canvases/c1/versions/1",
        ),
      ).toBe(true),
    );
  });

  it("keeps archived history editable but removes live-pointer actions", async () => {
    const historical = { ...VERSION, current: false };
    mockFetch({
      "GET /api/canvases/c1": () => json({ ...CANVAS, status: "archived" }),
      "GET /api/canvases/c1/versions": () => json({ versions: [historical] }),
      "GET /api/canvases/c1/draft": () => json(draftView()),
    });
    renderVersions();

    const row = (await screen.findByText("v1")).closest("li") as HTMLElement;
    expect(within(row).getByRole("link", { name: "Download ZIP" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Make current" })).toBeNull();
  });

  it("makes disabled history read-only except for downloads", async () => {
    const current = { ...VERSION, number: 2, current: true };
    const historical = { ...VERSION, number: 1, current: false };
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, status: "disabled", disabledReason: "policy" }),
      "GET /api/canvases/c1/versions": () => json({ versions: [current, historical] }),
      "GET /api/canvases/c1/draft": () => json(draftView()),
    });
    renderVersions();

    const row = (await screen.findByText("v1")).closest("li") as HTMLElement;
    expect(within(row).getByRole("link", { name: "Download ZIP" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Restore" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Make current" })).toBeNull();
    expect(within(row).getByText("Read-only while disabled")).toBeInTheDocument();
  });
});
