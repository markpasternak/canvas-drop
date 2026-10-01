import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOLD_MS } from "../components/HoldButton.js";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

const CANVAS = {
  id: "c1",
  slug: "quiet-otter",
  url: "http://x/c/quiet-otter",
  title: "My Canvas",
  description: null,
  access: "private",
  shared: false,
  guestAiEnabled: false,
  guestAiCap: 0,
  sharedExpiresAt: null,
  hasPassword: false,
  spaFallback: false,
  previewMode: "auto",
  linkPreview: false,
  galleryListed: false,
  galleryTemplatable: false,
  tags: null,
  clonedFromCanvasId: null,
  status: "active",
  publicationState: "draft",
  disabledReason: null,
  currentVersionId: null,
  createdAt: 0,
  updatedAt: 0,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handlers: Record<string, () => Response>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url, "http://localhost").pathname;
    calls.push({ method, url: path, body: init?.body as string | undefined });
    const handler = handlers[`${method} ${path}`];
    if (handler) return handler();
    return json({ error: "not_mocked" }, 500);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/canvases/c1/settings"] }),
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("settings route", () => {
  it("adds a Share tab before Versions", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json(CANVAS) });
    renderSettings();

    const share = await screen.findByRole("link", { name: "Share" });
    expect(share).toHaveAttribute("href", "/canvases/c1/share");
  });

  it("change-slug with an empty field regenerates a random slug (no slug in body)", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "POST /api/canvases/c1/regenerate-slug": () => json({ ...CANVAS, slug: "brave-lynx" }),
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: /change slug/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /change slug/i }));

    await vi.waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url === "/api/canvases/c1/regenerate-slug",
      );
      expect(post).toBeTruthy();
      // Empty field → random path → no slug in the request body.
      expect(post?.body ?? "{}").not.toContain("slug");
    });
  });

  it("change-slug to a custom value checks availability then POSTs the slug", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "GET /api/canvases/slug-available": () => json({ available: true }),
      "POST /api/canvases/c1/regenerate-slug": () => json({ ...CANVAS, slug: "team-hub" }),
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: /change slug/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Slug"), "team-hub");
    // Submit enables once the debounced availability check reports available.
    const submit = within(dialog).getByRole("button", { name: /change slug/i });
    await vi.waitFor(() => expect(submit).not.toBeDisabled());
    await user.click(submit);

    await vi.waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url === "/api/canvases/c1/regenerate-slug",
      );
      expect(post?.body).toContain("team-hub");
    });
  });

  it("toggles single-page app mode via PATCH", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "PATCH /api/canvases/c1/settings": () => json({ ...CANVAS, spaFallback: true }),
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("switch", { name: /single-page app mode/i }));

    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch?.body).toContain("spaFallback");
      expect(patch?.body).toContain("true");
    });
  });

  it("turns on link previews via PATCH", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "PATCH /api/canvases/c1/settings": () => json({ ...CANVAS, linkPreview: true }),
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("switch", { name: /show in link previews/i }));

    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(JSON.parse(patch?.body ?? "{}")).toEqual({ linkPreview: true });
    });
  });

  it("hides the link-preview toggle on an open public link (it already unfurls)", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json({ ...CANVAS, access: "public_link" }) });
    renderSettings();
    await screen.findByRole("switch", { name: /single-page app mode/i });
    expect(screen.queryByRole("switch", { name: /show in link previews/i })).toBeNull();
  });

  it("hides Unpublish for a Draft canvas", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json(CANVAS) });
    renderSettings();

    expect(await screen.findByRole("button", { name: "Archive canvas" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
  });

  it("unpublish confirms, then POSTs for a Published canvas", async () => {
    const published = { ...CANVAS, publicationState: "published", currentVersionId: "v1" };
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "POST /api/canvases/c1/unpublish": () =>
        json({ ...published, publicationState: "draft", currentVersionId: null }),
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: "Unpublish" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Unpublish" }));

    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/canvases/c1/unpublish")).toBe(
        true,
      ),
    );
  });

  it("regenerate-key reveals the new key once", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "POST /api/canvases/c1/regenerate-key": () => json({ apiKey: "cd_brandnewkey123" }),
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: /regenerate key/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));

    expect(await screen.findByText("cd_brandnewkey123")).toBeInTheDocument();
    expect(screen.getByText(/save your canvas key/i)).toBeInTheDocument();
  });

  it("duplicates the canvas from Settings", async () => {
    const clone = { ...CANVAS, id: "c2", slug: "copy-quiet-otter", title: "Copy of My Canvas" };
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "POST /api/canvases/c1/clone": () => json(clone, 201),
      "GET /api/canvases/c2": () => json(clone),
      "GET /api/canvases/c2/draft": () =>
        json({ files: [], stale: false, baseVersionId: null, updatedAt: 0, dirty: false }),
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: "Duplicate canvas" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Duplicate canvas" }));

    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/canvases/c1/clone")).toBe(
        true,
      ),
    );
  });

  it("separates reversible management from destructive actions and keeps credential consequences visible", async () => {
    const published = { ...CANVAS, publicationState: "published", currentVersionId: "v1" };
    mockFetch({ "GET /api/canvases/c1": () => json(published) });
    renderSettings();

    expect(await screen.findByRole("heading", { name: "Cover image" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Manage canvas" })).toBeInTheDocument();

    // Credential row (regenerate key) carries a warning badge + consequence helper text.
    const credBadge = screen.getByText("Credential");
    expect(credBadge).toHaveClass("text-warning");
    expect(screen.getByText(/will stop deploying until you update them/i)).toBeInTheDocument();

    // Archive is reversible; deletion carries the danger treatment.
    const archiveBtn = screen.getByRole("button", { name: "Archive canvas" });
    expect(archiveBtn).not.toHaveClass("bg-danger");
    expect(archiveBtn.querySelector("svg")).not.toBeNull();
    const deleteBtn = screen.getByRole("button", { name: "Delete canvas" });
    expect(deleteBtn).toHaveClass("bg-danger");
    expect(deleteBtn.querySelector("svg")).not.toBeNull();

    // Routine row (SPA mode) stays a plain control — no consequence badge in its row.
    expect(screen.getByRole("switch", { name: /single-page app mode/i })).toBeInTheDocument();
  });

  it("archive still confirms via the same dialog after the visual re-tiering", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "POST /api/canvases/c1/archive": () => json({ ...CANVAS, status: "archived" }),
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: "Archive canvas" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Archive" }));

    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/canvases/c1/archive")).toBe(
        true,
      ),
    );
  });

  it("delete confirms with a press-and-hold, then DELETEs", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "DELETE /api/canvases/c1": () => json({ ok: true }),
      "GET /api/canvases": () => json({ canvases: [] }),
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: /delete canvas/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    const action = within(dialog).getByRole("button", { name: /hold to delete/i });

    await user.click(action);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    fireEvent.pointerDown(action);
    await waitFor(
      () =>
        expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/canvases/c1")).toBe(true),
      { timeout: HOLD_MS + 1500 },
    );
  });
});

describe("settings — owner-only danger zone (editor-roles plan U6)", () => {
  it("an editor sees an owner-only notice instead of the Delete button", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          role: "editor",
          ownerId: "u9",
          owner: { id: "u9", name: "Olive", email: "o@example.com" },
        }),
    });
    renderSettings();
    expect(
      await screen.findByText(/only the owner \(olive\) can delete this canvas/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete canvas/i })).toBeNull();
  });

  it("the owner keeps the Delete button", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json({ ...CANVAS, role: "owner", ownerId: "u1" }) });
    renderSettings();
    expect(await screen.findByRole("button", { name: /delete canvas/i })).toBeInTheDocument();
  });
});
