import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
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
  shared: true,
  sharedExpiresAt: null,
  hasPassword: false,
  spaFallback: false,
  galleryListed: false,
  galleryTemplatable: false,
  gallerySummary: null,
  galleryTags: null,
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url, "http://localhost").pathname;
      if (path === "/api/canvases/c1") return json(canvas);
      if (path === "/api/canvases/c1/versions") return json({ versions });
      return json({ error: "not_mocked" }, 500);
    }),
  );
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

describe("canvas Status tab", () => {
  it("uses the new canvas workspace labels without changing route hrefs", async () => {
    mockStatus();
    renderStatus();

    expect(await screen.findByRole("link", { name: "Status" })).toHaveAttribute(
      "href",
      "/canvases/c1",
    );
    expect(screen.getByRole("link", { name: "Draft" })).toHaveAttribute(
      "href",
      "/canvases/c1/editor",
    );
    expect(screen.getByRole("link", { name: "Deploys" })).toHaveAttribute(
      "href",
      "/canvases/c1/versions",
    );
    expect(screen.getByRole("link", { name: "Backend" })).toHaveAttribute(
      "href",
      "/canvases/c1/capabilities",
    );
  });

  it("shows a healthy live state with the high-value facts", async () => {
    mockStatus();
    renderStatus();

    expect(await screen.findByText("Canvas is published")).toBeInTheDocument();
    // Header three-chip row (Publication · Visibility · Gallery) + the global
    // publish affordance, which on a non-editor tab reads "Publish files" (R7/R12).
    // "Published" appears in both the header chip and the Publication fact.
    expect(screen.getAllByText("Published").length).toBeGreaterThan(0);
    expect(screen.getByText("Unlisted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish files" })).toBeInTheDocument();
    // "Shared" appears in both the header Visibility chip and the Access fact.
    expect(screen.getAllByText("Shared").length).toBeGreaterThan(0);
    expect(screen.getByText(/v1 via folder upload/i)).toBeInTheDocument();
    expect(screen.getAllByText("2.0 KB")).toHaveLength(2);
    expect(screen.getByText("index.html")).toBeInTheDocument();
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
    expect(screen.getAllByRole("button", { name: "Publish files" }).length).toBeGreaterThan(0);
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
    mockStatus({ ...CANVAS, currentVersionId: null, shared: false, publicationState: "draft" }, []);
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
