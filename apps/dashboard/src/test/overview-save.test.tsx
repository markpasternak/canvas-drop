import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { keys } from "../lib/queries.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

// A published canvas with a known server-truth title/description/tags. The Overview
// Basics section seeds its local title/description/tags state from these.
const CANVAS = {
  id: "c1",
  slug: "quiet-otter",
  url: "http://x/c/quiet-otter",
  title: "Server Title",
  description: "Server description",
  access: "whole_org",
  shared: true,
  guestAiEnabled: false,
  guestAiCap: 0,
  sharedExpiresAt: null,
  hasPassword: false,
  spaFallback: false,
  previewMode: "auto",
  galleryListed: false,
  galleryTemplatable: false,
  tags: ["alpha"],
  clonedFromCanvasId: null,
  status: "active",
  publicationState: "published",
  disabledReason: null,
  currentVersionId: "v1",
  createdAt: 0,
  updatedAt: 0,
};

const VERSION = {
  number: 1,
  source: "folder",
  status: "ready",
  createdBy: "u1",
  createdAt: 1_700_000_000_000,
  fileCount: 2,
  totalBytes: 2048,
  current: true,
  entry: { path: "index.html", reason: "index" },
};

const ME = {
  id: "u1",
  email: "owner@example.com",
  name: "Owner",
  avatarUrl: null,
  isAdmin: false,
  canPublishPublic: false,
  authMode: "dev",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handlers: Record<string, () => Response>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const defaults: Record<string, () => Response> = {
    "GET /api/me": () => json(ME),
    "GET /api/canvases/c1": () => json(CANVAS),
    "GET /api/canvases/c1/versions": () => json({ versions: [VERSION] }),
  };
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url, "http://localhost").pathname;
    calls.push({ method, url: path, body: init?.body as string | undefined });
    const handler = handlers[`${method} ${path}`] ?? defaults[`${method} ${path}`];
    if (handler) return handler();
    return json({ error: "not_mocked" }, 500);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function renderOverview() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/canvases/c1"] }),
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
  return { router, qc };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Overview details recovery", () => {
  it("keeps failed version facts unavailable and supports retry without false empty claims", async () => {
    let failed = true;
    mockFetch({
      "GET /api/canvases/c1/versions": () =>
        failed
          ? json({ code: "UNAVAILABLE", message: "Unavailable" }, 503)
          : json({ versions: [VERSION] }),
    });
    const user = userEvent.setup();
    renderOverview();
    await screen.findByText("Couldn’t load version details");
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    expect(screen.queryByText("None yet")).toBeNull();
    expect(screen.queryByText("None")).toBeNull();
    expect(screen.queryByText("Not published yet")).toBeNull();
    failed = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Published version 1" })).toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).toBeNull();
  });
  it.each([
    ["Title", "Rejected Title", "Server Title"],
    ["Description", "Rejected description", "Server description"],
  ])(
    "retains a rejected %s and lets the author explicitly revert",
    async (label, attempted, original) => {
      mockFetch({
        "PATCH /api/canvases/c1/settings": () =>
          json({ code: "VALIDATION", message: "Could not save details." }, 422),
      });
      const user = userEvent.setup();
      renderOverview();
      await user.click(await screen.findByText("Edit details"));
      const input = screen.getByLabelText(label);
      await user.clear(input);
      await user.type(input, attempted);
      await user.click(screen.getByRole("button", { name: "Save details" }));
      expect(await screen.findByRole("button", { name: "Retry save" })).toBeInTheDocument();
      expect(input).toHaveValue(attempted);
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Revert changes" }));
      expect(input).toHaveValue(original);
      expect(screen.getByRole("button", { name: "Save details" })).toBeDisabled();
    },
  );

  it("retains tags after failure and retries the attempted batch", async () => {
    let fail = true;
    let saved = { ...CANVAS };
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(saved),
      "PATCH /api/canvases/c1/settings": () => {
        if (fail) return json({ code: "VALIDATION", message: "Could not save tags." }, 422);
        saved = { ...CANVAS, tags: ["alpha", "beta"] };
        return json(saved);
      },
    });
    const user = userEvent.setup();
    renderOverview();
    await user.click(await screen.findByText("Edit details"));
    await user.type(screen.getByLabelText("Tags"), "beta{Enter}");
    await user.click(screen.getByRole("button", { name: "Save details" }));
    await screen.findByRole("button", { name: "Retry save" });
    expect(
      within(screen.getByRole("list", { name: /current tags/i })).getByText("beta"),
    ).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry save" }));
    expect(await screen.findByText("Details saved")).toBeInTheDocument();
    expect(
      calls.filter((call) => call.method === "PATCH").map((call) => JSON.parse(call.body ?? "{}")),
    ).toEqual([{ tags: ["alpha", "beta"] }, { tags: ["alpha", "beta"] }]);
  });

  it("keeps failed edits mounted when navigation is blocked, then discards explicitly", async () => {
    mockFetch({
      "PATCH /api/canvases/c1/settings": () =>
        json({ code: "VALIDATION", message: "Cannot save right now." }, 422),
    });
    const user = userEvent.setup();
    const { router } = renderOverview();
    await user.click(await screen.findByText("Edit details"));
    await user.type(screen.getByLabelText("Title"), " attempted");
    await user.click(screen.getByRole("link", { name: "Gallery" }));
    const dialog = await screen.findByRole("dialog", { name: "Save your canvas details?" });
    await user.click(within(dialog).getByRole("button", { name: "Save and leave" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Cannot save right now");
    expect(router.state.location.pathname).toBe("/canvases/c1");
    expect(screen.getByLabelText("Title")).toHaveValue("Server Title attempted");
    await user.click(within(dialog).getByRole("button", { name: "Discard and leave" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/gallery"));
  });
  it("keeps dirty metadata mounted when a background read loses access", async () => {
    let unavailable = false;
    mockFetch({
      "GET /api/canvases/c1": () =>
        unavailable ? json({ code: "NOT_FOUND", message: "Not found" }, 404) : json(CANVAS),
    });
    const user = userEvent.setup();
    const { qc } = renderOverview();
    await user.click(await screen.findByText("Edit details"));
    await user.type(screen.getByLabelText("Title"), " unsaved");
    unavailable = true;
    await qc.refetchQueries({ queryKey: keys.canvas("c1") });
    expect(await screen.findByText("Couldn't refresh this canvas")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Server Title unsaved");
    expect(screen.queryByText("Canvas not found")).toBeNull();
  });

  it.each([
    [404, "Canvas not found"],
    [503, "Couldn’t load this canvas"],
  ])("distinguishes an initial %s from a temporary failure", async (status, title) => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ code: "UNAVAILABLE", message: "Unavailable" }, status as number),
    });
    renderOverview();
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByLabelText("Title")).toBeNull();
  });
});
