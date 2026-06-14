import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  return render(
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

  it("shows a published state and disables Publish draft when the draft is clean", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView({ dirty: false })),
      "GET /api/canvases/c1/draft/file": () => new Response("x", { status: 200 }),
    });
    renderEditor();
    expect(await screen.findByText(/all changes published/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Publish draft" })).toBeDisabled();
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
    const publishBtn = await screen.findByRole("button", { name: "Publish draft" });
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

  it("autosaves an edit to the draft file endpoint (debounced)", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView()),
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>orig</h1>", { status: 200 }),
      "PUT /api/canvases/c1/draft/file": () => json(draftView({ dirty: true })),
    });
    renderEditor();
    const editor = (await screen.findByTestId("code-editor")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain("orig"));
    fireEvent.change(editor, { target: { value: "<h1>edited</h1>" } });
    await waitFor(
      () =>
        expect(
          calls.some((c) => c.method === "PUT" && c.url.startsWith("/api/canvases/c1/draft/file")),
        ).toBe(true),
      { timeout: 2500 },
    );
  });

  it("flushes a pending autosave on unmount, so leaving the tab mid-edit isn't lost", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView()),
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>orig</h1>", { status: 200 }),
      "PUT /api/canvases/c1/draft/file": () => json(draftView({ dirty: true })),
    });
    const { unmount } = renderEditor();
    const editor = (await screen.findByTestId("code-editor")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain("orig"));
    // Edit, then leave before the 700ms debounce would fire — no PUT yet.
    fireEvent.change(editor, { target: { value: "<h1>edited</h1>" } });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    unmount();
    // The unmount flush must have dispatched the save with the edited content.
    await waitFor(() => {
      const put = calls.find(
        (c) => c.method === "PUT" && c.url.startsWith("/api/canvases/c1/draft/file"),
      );
      expect(put?.body).toContain("edited");
    });
  });

  it("renders an image preview (with Download) instead of the text editor", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () =>
        json(draftView({ files: [{ path: "logo.png", size: 120, mime: "image/png" }] })),
    });
    renderEditor();
    expect(await screen.findByText("logo.png")).toBeInTheDocument();
    expect((await screen.findAllByRole("link", { name: "Download file" })).length).toBeGreaterThan(
      0,
    );
    // The text editor is never mounted for a binary file.
    expect(screen.queryByTestId("code-editor")).not.toBeInTheDocument();
  });

  it("never opens a spreadsheet in the text editor — shows the can't-edit card (xlsx-crash class)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      // The server downgrades unknown extensions to text/plain; the allowlist must
      // still keep .xlsx out of CodeMirror (otherwise the bytes hang the tab).
      "GET /api/canvases/c1/draft": () =>
        json(draftView({ files: [{ path: "report.xlsx", size: 800_000, mime: "text/plain" }] })),
    });
    renderEditor();
    expect(await screen.findByText(/can.t edit this file type/i)).toBeInTheDocument();
    expect(screen.queryByTestId("code-editor")).not.toBeInTheDocument();
    // It also never fetches the bytes for the text editor.
    // (No GET to /draft/file is mocked; a request would 500 and surface — but none fires.)
  });

  it("offers Page text editing for a single-HTML draft", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView()), // one index.html
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>x</h1>", { status: 200 }),
    });
    renderEditor();
    const onPage = (await screen.findByRole("button", { name: "Page text" })) as HTMLButtonElement;
    expect(onPage.disabled).toBe(false);
  });

  it("disables Page text editing when the draft has several HTML files (explicit)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () =>
        json(
          draftView({
            files: [
              { path: "a.html", size: 10, mime: "text/html" },
              { path: "b.html", size: 10, mime: "text/html" },
            ],
          }),
        ),
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>x</h1>", { status: 200 }),
    });
    renderEditor();
    const onPage = (await screen.findByRole("button", { name: "Page text" })) as HTMLButtonElement;
    expect(onPage.disabled).toBe(true);
    expect(onPage.title).toMatch(/single HTML page \(this draft has 2\)/i);
  });

  it("Add a file refuses an existing path inline and never issues a write", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView()),
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>x</h1>", { status: 200 }),
    });
    renderEditor();
    await screen.findByText("index.html");
    fireEvent.click(await screen.findByRole("button", { name: "Add file" }));
    const field = await screen.findByPlaceholderText("e.g. styles/main.css");
    fireEvent.change(field, { target: { value: "index.html" } });
    expect(await screen.findByText(/already exists at that path/i)).toBeInTheDocument();
    const submit = screen
      .getAllByRole("button", { name: "Add file" })
      .find((b) => (b as HTMLButtonElement).type === "submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("Add a file creates a fresh path via the create-only endpoint (mode=create)", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView()),
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>x</h1>", { status: 200 }),
      "PUT /api/canvases/c1/draft/file": () =>
        json(
          draftView({
            files: [
              { path: "index.html", size: 10, mime: "text/html" },
              { path: "styles/main.css", size: 0, mime: "text/css" },
            ],
          }),
        ),
    });
    renderEditor();
    await screen.findByText("index.html");
    fireEvent.click(await screen.findByRole("button", { name: "Add file" }));
    const field = await screen.findByPlaceholderText("e.g. styles/main.css");
    fireEvent.change(field, { target: { value: "styles/main.css" } });
    const submit = screen
      .getAllByRole("button", { name: "Add file" })
      .find((b) => (b as HTMLButtonElement).type === "submit") as HTMLButtonElement;
    fireEvent.click(submit);
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "PUT" &&
            c.url.includes("/api/canvases/c1/draft/file") &&
            c.url.includes("mode=create") &&
            c.url.includes("styles%2Fmain.css"),
        ),
      ).toBe(true),
    );
  });

  it("Rename refuses renaming onto an existing path inline", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () =>
        json(
          draftView({
            files: [
              { path: "a.html", size: 10, mime: "text/html" },
              { path: "b.html", size: 10, mime: "text/html" },
            ],
          }),
        ),
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>x</h1>", { status: 200 }),
    });
    renderEditor();
    await screen.findByText("a.html");
    fireEvent.click(await screen.findByRole("button", { name: "Rename file" }));
    const field = await screen.findByDisplayValue("a.html");
    fireEvent.change(field, { target: { value: "b.html" } });
    expect(await screen.findByText(/already exists at that path/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
  });

  it("shows an error state when a file's content can't be loaded", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView()),
      "GET /api/canvases/c1/draft/file": () => json({ error: "not_found" }, 404),
    });
    renderEditor();
    expect(await screen.findByText(/couldn.t load this file/i)).toBeInTheDocument();
  });
});
