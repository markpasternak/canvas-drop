import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  gallerySummary: null,
  galleryTags: null,
  status: "active",
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

afterEach(() => vi.restoreAllMocks());

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

  it("delete is gated by type-to-confirm the slug, then DELETEs", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(CANVAS),
      "DELETE /api/canvases/c1": () => json({ ok: true }),
      "GET /api/canvases": () => json({ canvases: [] }),
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: /delete canvas/i }));
    const dialog = await screen.findByRole("dialog");
    const action = within(dialog).getByRole("button", { name: "Delete canvas" });
    // disabled until the slug is typed exactly
    expect(action).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "wrong");
    expect(action).toBeDisabled();
    await user.clear(within(dialog).getByRole("textbox"));
    await user.type(within(dialog).getByRole("textbox"), "quiet-otter");
    expect(action).toBeEnabled();
    await user.click(action);

    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/canvases/c1")).toBe(true),
    );
  });
});
