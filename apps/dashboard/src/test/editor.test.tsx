import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePane } from "../components/Surface.js";
import { ToastProvider } from "../components/Toast.js";
import type { DraftView } from "../lib/api.js";
import { keys } from "../lib/queries.js";
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
  previewMode: "auto",
  galleryListed: false,
  gallerySummary: null,
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

function mockFetch(handlers: Record<string, (init?: RequestInit) => Response>) {
  const calls: {
    method: string;
    url: string;
    body?: string;
    headers?: Record<string, string>;
  }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = new URL(url, "http://localhost");
    const key = `${method} ${u.pathname}`;
    calls.push({
      method,
      url: u.pathname + u.search,
      body: init?.body as string | undefined,
      headers: init?.headers as Record<string, string> | undefined,
    });
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
  return {
    qc,
    ...render(
      <ThemeProvider>
        <QueryClientProvider client={qc}>
          <ToastProvider>
            {/* biome-ignore lint/suspicious/noExplicitAny: test router instance */}
            <RouterProvider router={router as any} />
          </ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    ),
  };
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
    // The Editor tab shows two distinct publish affordances: the editor bar's
    // "Publish" (publishes the draft) and the global header "New version" (uploads
    // fresh files as a new version), shown on every tab.
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New version" })).toBeInTheDocument();
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

  it("shows a published state and disables Publish when the draft is clean", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView({ dirty: false })),
      "GET /api/canvases/c1/draft/file": () => new Response("x", { status: 200 }),
    });
    renderEditor();
    expect(await screen.findByText(/all changes published/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("enables Page text and shows the live inline preview for a static single-HTML draft", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView()),
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>hi</h1>", { status: 200 }),
    });
    renderEditor();
    expect(await screen.findByRole("button", { name: "Page text" })).toBeEnabled();
    // Static canvas keeps the sandboxed live inline preview frame.
    expect(document.querySelector('iframe[title="Draft preview"]')).not.toBeNull();
    expect(screen.queryByTestId("preview-scripts-notice")).toBeNull();
  });

  it("disables Page text and swaps the preview for the JS notice when the draft ships JS", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () =>
        json(
          draftView({
            files: [
              { path: "index.html", size: 10, mime: "text/html" },
              { path: "app.js", size: 10, mime: "text/javascript" },
            ],
          }),
        ),
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>hi</h1>", { status: 200 }),
    });
    renderEditor();
    // Page-text editing is meaningless for JS-rendered content — gated off with the hint.
    expect(await screen.findByRole("button", { name: "Page text" })).toBeDisabled();
    // Preview swaps to the notice + full-preview CTA; no sandboxed frame.
    expect(await screen.findByTestId("preview-scripts-notice")).toBeInTheDocument();
    expect(document.querySelector('iframe[title="Draft preview"]')).toBeNull();
  });

  it("offers to add index.html when the draft has no HTML page", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () =>
        json(draftView({ files: [{ path: "styles.css", size: 10, mime: "text/css" }] })),
      "GET /api/canvases/c1/draft/file": () => new Response("body {}", { status: 200 }),
      "PUT /api/canvases/c1/draft/file": () => json(draftView()),
    });
    renderEditor();

    expect(await screen.findByText("No HTML page in this draft")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add index.html" }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "PUT" &&
            c.url === "/api/canvases/c1/draft/file?path=index.html&mode=create",
        ),
      ).toBe(true),
    );
  });

  it("offers to rename a single inferred HTML page to index.html", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () =>
        json(draftView({ files: [{ path: "page.html", size: 10, mime: "text/html" }] })),
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>hi</h1>", { status: 200 }),
      "POST /api/canvases/c1/draft/rename": () => json(draftView()),
    });
    renderEditor();

    expect(await screen.findByText("Home page is inferred")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Rename to index.html" }));

    await waitFor(() => {
      const rename = calls.find(
        (c) => c.method === "POST" && c.url === "/api/canvases/c1/draft/rename",
      );
      expect(rename?.body).toContain('"from":"page.html"');
      expect(rename?.body).toContain('"to":"index.html"');
    });
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

  it("⌘↵ publishes when the draft is dirty and publishable", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView({ dirty: true })),
      "GET /api/canvases/c1/draft/file": () => new Response("x", { status: 200 }),
      "POST /api/canvases/c1/publish": () =>
        json({ version: 2, versionId: "v2", fileCount: 1, totalBytes: 1 }),
    });
    renderEditor();
    // Wait for the editor to be live (Publish enabled) before firing the shortcut.
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled());
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/canvases/c1/publish")).toBe(
        true,
      ),
    );
  });

  it("Ctrl+↵ also publishes", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView({ dirty: true })),
      "GET /api/canvases/c1/draft/file": () => new Response("x", { status: 200 }),
      "POST /api/canvases/c1/publish": () =>
        json({ version: 2, versionId: "v2", fileCount: 1, totalBytes: 1 }),
    });
    renderEditor();
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled());
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/canvases/c1/publish")).toBe(
        true,
      ),
    );
  });

  it("⌘↵ is a no-op when the draft isn't publishable (clean)", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView({ dirty: false })),
      "GET /api/canvases/c1/draft/file": () => new Response("x", { status: 200 }),
      "POST /api/canvases/c1/publish": () =>
        json({ version: 2, versionId: "v2", fileCount: 1, totalBytes: 1 }),
    });
    renderEditor();
    // Publish is disabled for a clean draft; the shortcut must respect the same gate.
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled());
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    // Give any (incorrect) publish a chance to fire, then assert none did.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/canvases/c1/publish")).toBe(
      false,
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
    // The unmount flush must have dispatched the save with the edited content,
    // pinned to the draft's fork-point so a flush landing after a restore is rejected.
    await waitFor(() => {
      const put = calls.find(
        (c) => c.method === "PUT" && c.url.startsWith("/api/canvases/c1/draft/file"),
      );
      expect(put?.body).toContain("edited");
      expect(put?.headers?.["If-Draft-Base"]).toBe("v1");
    });
  });

  it("marks the draft dirty on unmount so an in-window edit can't bypass the restore confirm", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/c1/draft": () => json(draftView({ dirty: false })),
      "GET /api/canvases/c1/draft/file": () => new Response("<h1>orig</h1>", { status: 200 }),
      "PUT /api/canvases/c1/draft/file": () => json(draftView({ dirty: true })),
    });
    const { unmount, qc } = renderEditor();
    const editor = (await screen.findByTestId("code-editor")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain("orig"));
    // The draft cache starts clean (the restore fast-path would skip confirmation).
    expect(qc.getQueryData<DraftView>(keys.draft("c1"))?.dirty).toBe(false);
    // Edit inside the debounce window, then leave the tab.
    fireEvent.change(editor, { target: { value: "<h1>edited</h1>" } });
    unmount();
    // Synchronously after unmount the shared draft cache is flagged dirty, so the
    // Versions tab's `draft.dirty` confirm-gate fires before discarding this edit.
    expect(qc.getQueryData<DraftView>(keys.draft("c1"))?.dirty).toBe(true);
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

describe("WorkspacePane chrome (flat)", () => {
  it("renders a flat bordered pane with no rounded-card / shadow chrome", () => {
    const { container } = render(
      <WorkspacePane data-testid="pane">
        <div>contents</div>
      </WorkspacePane>,
    );
    const pane = container.querySelector("section");
    expect(pane).not.toBeNull();
    // KTD4: the editor's panes are flat bordered seams, not rounded shadow cards.
    expect(pane?.className).not.toMatch(/\brounded-xl\b/);
    expect(pane?.className).not.toMatch(/shadow-\[var\(--shadow-panel\)\]/);
    // Still a bordered pane (the hairline seams between panes).
    expect(pane?.className).toMatch(/\bborder\b/);
  });
});
