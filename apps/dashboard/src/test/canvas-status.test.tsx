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
  access: "whole_org",
  shared: true,
  sharedExpiresAt: null,
  hasPassword: false,
  spaFallback: false,
  previewMode: "auto",
  galleryListed: false,
  galleryTemplatable: false,
  tags: null,
  clonedFromCanvasId: null,
  backendEnabled: false,
  capabilities: { kv: true, files: true, ai: true, realtime: true },
  effective: { identity: false, kv: false, files: false, ai: false, realtime: false },
  status: "active",
  publicationState: "published" as string,
  disabledReason: null as string | null,
  currentVersionId: "v1" as string | null,
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockStatus(canvas = CANVAS, versions: unknown[] = [VERSION]) {
  const calls: { method: string; url: string; body?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url, "http://localhost").pathname;
      calls.push({ method, url: path, body: init?.body as string | undefined });
      if (path === "/api/canvases/c1") return json(canvas);
      if (path === "/api/canvases/c1/settings") return json(canvas);
      if (path === "/api/canvases/c1/versions") return json({ versions });
      return json({ error: "not_mocked" }, 500);
    }),
  );
  return calls;
}

function renderStatus() {
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
}

afterEach(() => vi.unstubAllGlobals());

describe("canvas Overview tab", () => {
  it("uses the new canvas workspace labels without changing route hrefs", async () => {
    mockStatus();
    renderStatus();

    expect(await screen.findByRole("link", { name: "Overview" })).toHaveAttribute(
      "href",
      "/canvases/c1",
    );
    expect(screen.getByRole("link", { name: "Editor" })).toHaveAttribute(
      "href",
      "/canvases/c1/editor",
    );
    expect(screen.getByRole("link", { name: "Versions" })).toHaveAttribute(
      "href",
      "/canvases/c1/versions",
    );
    expect(screen.getByRole("link", { name: "Backend" })).toHaveAttribute(
      "href",
      "/canvases/c1/capabilities",
    );
  });

  it("renders a flat editorial shell header (serif title, no boxed card, live-URL affordances)", async () => {
    mockStatus();
    renderStatus();

    // Title is the serif page heading, not a sans card title.
    const title = await screen.findByRole("heading", { level: 1, name: "My Canvas" });
    expect(title.className).toContain("font-serif");

    // The shell header is flat — no rounded-xl/shadow card wrapper around it.
    const header = title.closest("header");
    expect(header).not.toBeNull();
    expect(header?.className ?? "").not.toMatch(/rounded-xl|shadow-/);

    // All seven tabs present in the underline tab bar (Share/Usage/Settings included).
    // The active-tab aria-current marking is covered at the unit level in tab-nav.test.tsx.
    for (const label of [
      "Overview",
      "Editor",
      "Share",
      "Versions",
      "Backend",
      "Usage",
      "Settings",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }

    // Live-URL copy + open affordances are present and labelled in the header.
    const headerEl = header as HTMLElement;
    expect(within(headerEl).getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(within(headerEl).getByRole("link", { name: "Open live canvas" })).toHaveAttribute(
      "href",
      CANVAS.url,
    );
  });

  it("shows a healthy live state with the high-value facts", async () => {
    mockStatus();
    renderStatus();

    expect(await screen.findByText("Canvas is published")).toBeInTheDocument();
    // Header three-chip row (Publication · Visibility · Gallery) + the global
    // "New version" upload affordance (shown on every tab).
    // "Published" appears in both the header chip and the Publication fact.
    expect(screen.getAllByText("Published").length).toBeGreaterThan(0);
    expect(screen.getByText("Unlisted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New version" })).toBeInTheDocument();
    // "Whole org" appears in both the header access chip and the Access fact.
    expect(screen.getAllByText("Whole org").length).toBeGreaterThan(0);
    expect(screen.getByText(/v1 via folder upload/i)).toBeInTheDocument();
    expect(screen.getAllByText("2.0 KB")).toHaveLength(2);
    expect(screen.getByText("index.html")).toBeInTheDocument();

    // Flat redesign (U3): the Basics group is a serif-headed flat band, not a boxed
    // Panel card — its section carries no rounded-xl/shadow wrapper.
    const basics = screen.getByRole("heading", { level: 2, name: "Basics" });
    expect(basics.className).toContain("font-serif");
    const basicsSection = basics.closest("section");
    expect(basicsSection?.className ?? "").not.toMatch(/rounded-xl|shadow-/);
  });

  it("edits the canvas title and description from Overview", async () => {
    const calls = mockStatus();
    const user = userEvent.setup();
    renderStatus();

    await user.clear(await screen.findByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "Roadshow prototype");
    await user.tab();

    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch?.body).toContain("Roadshow prototype");
    });

    await user.type(screen.getByLabelText("Description"), "Shared with the launch team.");
    await user.tab();

    await vi.waitFor(() => {
      const patches = calls.filter(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patches.at(-1)?.body).toContain("Shared with the launch team.");
    });
  });

  it("turns a deploy without HTML into a repair workflow", async () => {
    mockStatus(CANVAS, [
      {
        ...VERSION,
        totalBytes: 0,
        fileCount: 0,
        entry: { path: null, reason: "none" },
      },
    ]);
    renderStatus();

    expect(await screen.findByText("Root page missing")).toBeInTheDocument();
    expect(screen.getByText(/Add an/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open draft" })).toHaveAttribute(
      "href",
      "/canvases/c1/editor",
    );
    expect(screen.getAllByRole("button", { name: "New version" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Entry file")).not.toBeInTheDocument();
  });

  it("explains the ambiguous multiple-page repair path", async () => {
    mockStatus(CANVAS, [
      {
        ...VERSION,
        fileCount: 2,
        entry: { path: null, reason: "ambiguous" },
      },
    ]);
    renderStatus();

    expect(await screen.findByText("Root page missing")).toBeInTheDocument();
    expect(screen.getByText(/multiple HTML pages/i)).toBeInTheDocument();
    expect(screen.getByText(/Rename the home page to/i)).toBeInTheDocument();
  });

  it("handles a canvas with no live deploy yet", async () => {
    mockStatus(
      {
        ...CANVAS,
        access: "private",
        currentVersionId: null,
        shared: false,
        publicationState: "draft",
      },
      [],
    );
    renderStatus();

    expect(await screen.findByText("Not published yet")).toBeInTheDocument();
    expect(screen.getByText(/The URL has no live page/i)).toBeInTheDocument();
    // "Private" appears in both the header Visibility chip and the Access fact.
    expect(screen.getAllByText("Private").length).toBeGreaterThan(0);
  });

  it("keeps the disabled state explicit", async () => {
    mockStatus({
      ...CANVAS,
      status: "disabled",
      publicationState: "disabled",
      disabledReason: "Terms of service violation",
    });
    renderStatus();

    expect(await screen.findByText("Canvas disabled")).toBeInTheDocument();
    expect(screen.getByText("Terms of service violation")).toBeInTheDocument();
  });

  it("keeps the archived state explicit", async () => {
    mockStatus({ ...CANVAS, status: "archived", publicationState: "archived" });
    renderStatus();

    expect(await screen.findByText("Canvas archived")).toBeInTheDocument();
    expect(screen.getByText(/Unarchive it to bring the same URL back/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeInTheDocument();
  });
});
