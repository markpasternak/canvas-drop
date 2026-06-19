import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

/** A canvas-list row as the API serializes it (matches the shared filters-test stub). */
function canvas(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    slug: "s1",
    url: "http://x/c/s1",
    title: "Canvas One",
    description: null,
    shared: false,
    sharedExpiresAt: null,
    hasPassword: false,
    spaFallback: false,
    previewMode: "auto",
    galleryListed: false,
    galleryTemplatable: false,
    tags: null,
    status: "active",
    publicationState: "published",
    disabledReason: null,
    currentVersionId: "v1",
    viewCount: 0,
    lastViewedAt: null,
    createdAt: 0,
    updatedAt: 0,
    recentViews: 0,
    lastDeploy: { version: 1, createdAt: 0, fileCount: 1, totalBytes: 10 },
    ...over,
  };
}

/** A draft canvas: no published version, draft lifecycle, never deployed. */
function draft(over: Record<string, unknown> = {}) {
  return canvas({
    publicationState: "draft",
    currentVersionId: null,
    lastDeploy: null,
    ...over,
  });
}

function summaryFor(canvases: Array<ReturnType<typeof canvas>>) {
  const activeRows = canvases.filter((c) => c.status !== "archived" && c.status !== "deleted");
  return {
    active: activeRows.length,
    archived: canvases.filter((c) => c.status === "archived").length,
    shared: activeRows.filter((c) => c.shared).length,
    protected: activeRows.filter((c) => c.hasPassword).length,
    listed: activeRows.filter((c) => c.galleryListed).length,
    templates: activeRows.filter((c) => c.galleryTemplatable).length,
    neverDeployed: activeRows.filter((c) => c.lastDeploy === null).length,
  };
}

function stub(all: Array<ReturnType<typeof canvas>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url, "http://localhost");
      const path = u.pathname;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (path === "/api/me") {
        return json({
          id: "u1",
          email: "u@x",
          name: "U",
          avatarUrl: null,
          isAdmin: false,
          authMode: "dev",
        });
      }
      const sp = u.searchParams;
      const archivedScope = sp.get("scope") === "archived";
      const matched = all.filter((c) => {
        if (archivedScope) {
          if (c.status !== "archived") return false;
        } else if (c.status === "archived" || c.status === "deleted") {
          return false;
        }
        if (sp.get("shared") === "1" && !c.shared) return false;
        const q = sp.get("q")?.toLowerCase();
        if (q && !c.title.toLowerCase().includes(q)) return false;
        return true;
      });
      const limit = Number(sp.get("limit") ?? 30);
      const offset = Number(sp.get("offset") ?? 0);
      return json({
        canvases: matched.slice(offset, offset + limit),
        total: matched.length,
        limit,
        offset,
        summary: summaryFor(all),
      });
    }),
  );
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
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

/** The strip is an aria-labelled region — locate it without depending on layout. */
function findStrip() {
  return screen.queryByRole("region", { name: "Finish this canvas" });
}

beforeEach(() => {
  try {
    localStorage.setItem("canvas-drop:owner-view", "list");
  } catch {
    /* jsdom always has localStorage; defensive */
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* defensive */
  }
});

describe("U11 — sparse 'finish this' strip", () => {
  it("appears for the most-recent draft with the publish next-step + Open draft action", async () => {
    stub([
      canvas({ id: "pub", slug: "pub", title: "Published one", updatedAt: 10 }),
      draft({ id: "wip", slug: "wip", title: "Draft one", updatedAt: 50 }),
    ]);
    renderAt("/");
    await screen.findByText("Published one");

    const strip = findStrip();
    expect(strip).not.toBeNull();
    const region = strip as HTMLElement;
    // Surfaces the most-recently-touched draft (the WIP), not the published one.
    expect(within(region).getByText("Draft one")).toBeInTheDocument();
    // The single next step is the publish guidance.
    expect(within(region).getByText(/publish to get a live url/i)).toBeInTheDocument();
    expect(within(region).getByText(/draft — not live yet/i)).toBeInTheDocument();
    // Primary action opens the draft (the editor, where Publish lives).
    const open = within(region).getByRole("link", { name: "Open draft" });
    expect(open).toHaveAttribute("href", "/canvases/wip/editor");
  });

  it("is absent when the library is large and fully published (dense)", async () => {
    // 6 published canvases (> sparse threshold of 3), none a draft → not sparse.
    const many = Array.from({ length: 6 }, (_, i) =>
      canvas({ id: `c${i}`, slug: `s${i}`, title: `Canvas ${i}`, updatedAt: i }),
    );
    stub(many);
    renderAt("/");
    await screen.findByText("Canvas 0");
    expect(findStrip()).toBeNull();
  });

  it("appears when a large library's most-recent canvas is a draft", async () => {
    // 5 published + 1 draft that is the most recently touched → sparse via the draft rule.
    const many = Array.from({ length: 5 }, (_, i) =>
      canvas({ id: `c${i}`, slug: `s${i}`, title: `Canvas ${i}`, updatedAt: i }),
    );
    many.push(draft({ id: "wip", slug: "wip", title: "Fresh draft", updatedAt: 999 }));
    stub(many);
    renderAt("/");
    await screen.findByText("Canvas 0");

    const strip = findStrip();
    expect(strip).not.toBeNull();
    expect(within(strip as HTMLElement).getByText("Fresh draft")).toBeInTheDocument();
  });

  it("is absent at the zero state (Onboarding owns it)", async () => {
    stub([]);
    renderAt("/");
    expect(await screen.findByText(/ship your first canvas/i)).toBeInTheDocument();
    expect(findStrip()).toBeNull();
  });

  it("surfaces a published canvas with a Share next-step when sparse with no draft", async () => {
    // 2 published canvases (≤ 3, sparse) and none is a draft → fall back to the
    // most-recent published canvas, whose next step is Share.
    stub([
      canvas({ id: "a", slug: "a", title: "Older pub", updatedAt: 1 }),
      canvas({ id: "b", slug: "b", title: "Newer pub", updatedAt: 9 }),
    ]);
    renderAt("/");
    await screen.findByText("Older pub");

    const strip = findStrip();
    expect(strip).not.toBeNull();
    const region = strip as HTMLElement;
    expect(within(region).getByText("Newer pub")).toBeInTheDocument();
    expect(within(region).getByText(/share it/i)).toBeInTheDocument();
    const share = within(region).getByRole("link", { name: "Share" });
    expect(share).toHaveAttribute("href", "/canvases/b/share");
  });

  it("is absent in the archived scope", async () => {
    stub([draft({ id: "arc", slug: "arc", title: "Archived draft", status: "archived" })]);
    renderAt("/?scope=archived");
    await screen.findByText("Archived draft");
    expect(findStrip()).toBeNull();
  });

  it("is absent while a filter is active", async () => {
    stub([draft({ id: "wip", slug: "wip", title: "Draft one", shared: true })]);
    renderAt("/?shared=true");
    await screen.findByText("Draft one");
    expect(findStrip()).toBeNull();
  });

  it("exposes a keyboard-reachable primary action (a real anchor)", async () => {
    stub([draft({ id: "wip", slug: "wip", title: "Draft one" })]);
    renderAt("/");
    // "Draft one" renders in both the strip and the list row, so wait on the strip's
    // own action rather than the (duplicated) title.
    const open = await screen.findByRole("link", { name: "Open draft" });
    // Anchors are natively focusable/keyboard-activatable; assert it is a real link
    // (not a div) with a valid href, and not removed from the tab order.
    expect(open.tagName.toLowerCase()).toBe("a");
    expect(open).toHaveAttribute("href", "/canvases/wip/editor");
    expect(open).not.toHaveAttribute("tabindex", "-1");
  });
});
