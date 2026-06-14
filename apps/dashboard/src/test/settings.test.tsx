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
  shared: false,
  sharedExpiresAt: null,
  hasPassword: false,
  spaFallback: false,
  galleryListed: false,
  galleryTemplatable: false,
  gallerySummary: null,
  galleryTags: null,
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

/** Mock fetch by `${METHOD} ${pathname}`; records every call for assertions. */
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

describe("settings route — confirm-and-await flows", () => {
  it("sets a password via PATCH", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "PATCH /api/canvases/c1/settings": () => json({ ...CANVAS, hasPassword: true }),
    });
    const user = userEvent.setup();
    renderSettings();

    await user.type(await screen.findByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: /set password/i }));

    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch).toBeTruthy();
      expect(patch?.body).toContain("hunter2");
    });
  });

  it("Generate fills a strong password and reveals it for copying", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json(CANVAS) });
    const user = userEvent.setup();
    renderSettings();

    const input = (await screen.findByLabelText("Password")) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.type).toBe("password");

    await user.click(screen.getByRole("button", { name: "Generate" }));
    // a non-trivial value appears and is shown (not masked) so it can be copied
    expect(input.value.length).toBeGreaterThanOrEqual(16);
    expect(input.type).toBe("text");
  });

  it("regenerate-slug confirms, then POSTs", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "POST /api/canvases/c1/regenerate-slug": () => json({ ...CANVAS, slug: "brave-lynx" }),
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: /regenerate slug/i }));
    // a confirm dialog appears with a verb-labeled action
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));

    await vi.waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.url === "/api/canvases/c1/regenerate-slug"),
      ).toBe(true),
    );
  });

  it("hides Unpublish for a Draft canvas", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json(CANVAS) }); // base: publicationState "draft"
    renderSettings();
    // Settings loaded (the Lifecycle section's Archive control is present)...
    expect(await screen.findByRole("button", { name: "Archive canvas" })).toBeInTheDocument();
    // ...but a Draft canvas has nothing to unpublish.
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
      expect(
        calls.some((c) => c.method === "POST" && c.url === "/api/canvases/c1/unpublish"),
      ).toBe(true),
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

    // the reveal modal shows the once-shown key
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
    // No type-to-confirm gate: the press-and-hold gesture is the confirmation.
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    const action = within(dialog).getByRole("button", { name: /hold to delete/i });

    // A click (press + immediate release) must NOT delete — releasing early cancels.
    await user.click(action);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    // Holding past the threshold fires the delete (real timers — HOLD_MS wall time).
    fireEvent.pointerDown(action);
    await waitFor(
      () =>
        expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/canvases/c1")).toBe(true),
      { timeout: HOLD_MS + 1500 },
    );
  });

  it("warns when a shared canvas's expiry is already in the past", async () => {
    const past = Date.now() - 60 * 60 * 1000; // an hour ago
    mockFetch({
      "GET /api/canvases/c1": () => json({ ...CANVAS, shared: true, sharedExpiresAt: past }),
    });
    renderSettings();
    expect(await screen.findByText(/this share expired/i)).toBeInTheDocument();
    expect(screen.getByText(/non-owners now get a 404/i)).toBeInTheDocument();
  });

  it("shows no expiry warning when the expiry is still in the future", async () => {
    const future = Date.now() + 24 * 60 * 60 * 1000; // tomorrow
    mockFetch({
      "GET /api/canvases/c1": () => json({ ...CANVAS, shared: true, sharedExpiresAt: future }),
    });
    renderSettings();
    // The Sharing section renders (shared toggle on); the expired notice does not.
    expect(await screen.findByText(/share expiry/i)).toBeInTheDocument();
    expect(screen.queryByText(/this share expired/i)).toBeNull();
  });

  it("gallery-listing control is discoverable but disabled until the canvas is shared", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json({ ...CANVAS, shared: false }) });
    renderSettings();
    // The control is visible (not hidden) even on a private canvas...
    const toggle = await screen.findByRole("switch", { name: /list in the gallery/i });
    expect(toggle).toBeDisabled();
    // ...with a hint explaining the prerequisite.
    expect(screen.getByText(/turn on/i)).toBeInTheDocument();
    expect(screen.getByText(/to list this canvas in the gallery/i)).toBeInTheDocument();
  });

  it("gallery-listing control is enabled once the canvas is shared AND published", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json({ ...CANVAS, shared: true, currentVersionId: "v1" }),
    });
    renderSettings();
    const toggle = await screen.findByRole("switch", { name: /list in the gallery/i });
    expect(toggle).toBeEnabled();
  });

  it("gallery-listing is blocked (disabled) for a shared-but-unpublished canvas", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json({ ...CANVAS, shared: true, currentVersionId: null }),
    });
    renderSettings();
    const toggle = await screen.findByRole("switch", { name: /list in the gallery/i });
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/publish this canvas before listing/i)).toBeInTheDocument();
  });

  it("gallery-listing is blocked (disabled) for a password-protected canvas", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, shared: true, currentVersionId: "v1", hasPassword: true }),
    });
    renderSettings();
    const toggle = await screen.findByRole("switch", { name: /list in the gallery/i });
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/remove the password before listing/i)).toBeInTheDocument();
  });

  it("shows the template toggle once listed, and warns before a password unlists — confirming fires the PATCH", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, shared: true, currentVersionId: "v1", galleryListed: true }),
      "PATCH /api/canvases/c1/settings": () =>
        json({ ...CANVAS, shared: true, currentVersionId: "v1", hasPassword: true }),
    });
    const user = userEvent.setup();
    renderSettings();
    // Template toggle is offered for a listed canvas.
    expect(
      await screen.findByRole("switch", { name: /allow others to use as a template/i }),
    ).toBeInTheDocument();
    // Setting a password on a listed canvas warns first (doesn't fire immediately).
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: /set password/i }));
    expect(await screen.findByText(/add a password and unlist/i)).toBeInTheDocument();
    // No PATCH yet — the warning gates the write.
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    // Confirming fires the password PATCH.
    await user.click(screen.getByRole("button", { name: /add password & remove from gallery/i }));
    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch?.body).toContain("hunter2");
    });
  });

  it("surfaces a gallery-toggle server rejection as an error toast (not a silent rollback)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, shared: true, currentVersionId: "v1", galleryListed: true }),
      "PATCH /api/canvases/c1/settings": () =>
        json({ code: "NOT_PUBLISHED", message: "Publish this canvas before listing it." }, 409),
    });
    const user = userEvent.setup();
    renderSettings();

    // Toggling the template switch hits saveGallery → the 409 must toast its hint.
    await user.click(
      await screen.findByRole("switch", { name: /allow others to use as a template/i }),
    );
    expect(
      await screen.findByText(/publish this canvas before listing it in the gallery/i),
    ).toBeInTheDocument();
  });
});
