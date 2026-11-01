import { createHash, webcrypto } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { api } from "../lib/api.js";
import { clearCreateRecovery } from "../lib/create-recovery.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

const ME = {
  id: "u1",
  email: "owner@example.com",
  name: "Owner",
  isAdmin: false,
  canPublishPublic: true,
  authMode: "dev",
  urlMode: "path",
  baseUrl: "http://localhost:3000",
  orgs: [{ id: "org1", name: "Acme" }],
};
const CANVAS = {
  id: "c1",
  title: "Draft",
  slug: "new",
  url: "http://x/c/new",
  apiKey: "cd_once",
  access: "private",
  status: "active",
  currentVersionId: null as string | null,
  publicationState: "draft",
  backendEnabled: false,
  orgId: "org1",
  sharedExpiresAt: null,
  hasPassword: false,
  capabilities: {},
  effective: {},
  tags: [],
};
const DRAFT = {
  files: [{ path: "index.html", mime: "text/html", size: 20, hash: "h1" }],
  entry: { path: "index.html", reason: "index" as const },
  dirty: true,
  stale: false,
  changes: [],
  baseVersionId: null,
  updatedAt: 0,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function mockFetch(me = ME, failSettings = false) {
  const calls: Array<{ method: string; path: string; query: string; body?: unknown }> = [];
  let canvas = { ...CANVAS };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url,
        "http://localhost",
      );
      const method = init?.method ?? "GET";
      let body: unknown;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ method, path: url.pathname, query: url.search, body });
      if (url.pathname === "/api/me") return json(me);
      if (url.pathname === "/api/canvases" && method === "POST") return json(canvas);
      if (url.pathname === "/api/canvases/c1") return json(canvas);
      if (url.pathname.endsWith("/draft") || url.pathname.endsWith("/draft/file"))
        return json(DRAFT);
      if (url.pathname.endsWith("/settings") && method === "PATCH") {
        if (!canvas.currentVersionId) return json({ code: "SHARE_REQUIRES_PUBLISH" }, 409);
        if (failSettings) return json({ code: "SHARE_FAILED", message: "unavailable" }, 500);
        canvas = { ...canvas, ...(body as object) };
        return json(canvas);
      }
      if (url.pathname.endsWith("/publish")) {
        canvas = {
          ...canvas,
          currentVersionId: "v1",
          publicationState: "published",
        };
        return json({ version: 1 });
      }
      if (url.pathname.endsWith("/teams")) return json({ teams: [] });
      return json({ canvases: [], total: 0, limit: 30, offset: 0 });
    }),
  );
  return calls;
}
function renderNew(path = "/new") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          {/* biome-ignore lint/suspicious/noExplicitAny: test router */}
          <RouterProvider router={router as any} />
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { router, qc };
}
function chooseFiles(files: File[]) {
  const input = document.querySelector<HTMLInputElement>(
    'input[type="file"]:not([webkitdirectory])',
  );
  if (!input) throw new Error("Missing file picker");
  fireEvent.change(input, { target: { files } });
}
async function pasteDraft() {
  fireEvent.change(await screen.findByLabelText("HTML"), { target: { value: "<h1>Hello</h1>" } });
  await userEvent.click(screen.getByRole("button", { name: "Create draft" }));
  await screen.findByRole("heading", { name: "Your draft is ready" });
}
afterEach(() => {
  clearCreateRecovery();
  vi.unstubAllGlobals();
});

describe("draft-first creation and recovery", () => {
  it("reviews the planned audience, publishes Restricted, then applies sharing", async () => {
    const calls = mockFetch();
    renderNew();
    expect(await screen.findByRole("heading", { name: "Audience", level: 2 })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Restricted" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Everyone in Acme" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "List in Shared" }));
    await pasteDraft();
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/canvases",
      "PUT /api/canvases/c1/draft/file",
    ]);
    expect(screen.getByText("Acme")).toBeVisible();
    expect(screen.getByText(/index.html/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Review and publish" }));
    const dialog = await screen.findByRole("dialog", { name: "Review before publishing" });
    expect(calls.some((c) => c.path.endsWith("/publish"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(within(dialog).getByText("Everyone in Acme")).toBeVisible();
    expect(within(dialog).getByText(/Publication happens first/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish canvas" }));
    expect(await screen.findByRole("heading", { name: "Your canvas is published" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Go to canvas" })).toBeVisible();
    expect(
      calls.filter((c) => c.path.endsWith("/publish") || c.method === "PATCH").map((c) => c.path),
    ).toEqual(["/api/canvases/c1/publish", "/api/canvases/c1/settings"]);
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      access: "whole_org",
      discoverability: "listed",
    });
  });
  it("preserves publication and offers Check sharing when audience setup cannot be confirmed", async () => {
    const calls = mockFetch({ ...ME, orgs: [] }, true);
    renderNew();
    await userEvent.click(await screen.findByRole("radio", { name: "Public link" }));
    await pasteDraft();
    await userEvent.click(screen.getByRole("button", { name: "Review and publish" }));
    const dialog = await screen.findByRole("dialog", { name: "Review before publishing" });
    expect(within(dialog).getByText(/Public link · Anyone with the link/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish canvas" }));
    expect(await screen.findByRole("heading", { name: "Your canvas is published" })).toBeVisible();
    expect(screen.getByText("Sharing needs verification")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check sharing" })).toBeVisible();
    expect(calls.filter((c) => c.path.endsWith("/publish"))).toHaveLength(1);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
  it("keeps title and content on failed creates and explicit discard clears recovery", async () => {
    mockFetch();
    vi.spyOn(api, "createCanvas").mockRejectedValue(new Error("Offline"));
    renderNew();
    fireEvent.change(await screen.findByLabelText("HTML"), {
      target: { value: "<title>Recovered</title>" },
    });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My work" } });
    await userEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText(/Offline/)).toBeVisible();
    expect(screen.getByLabelText("HTML")).toHaveValue("<title>Recovered</title>");
    expect(screen.getByLabelText("Title")).toHaveValue("My work");
    await userEvent.click(screen.getByRole("button", { name: "Discard preparation" }));
    expect(screen.getByLabelText("HTML")).toHaveValue("");
    expect(screen.getByLabelText("Title")).toHaveValue("");
  });
  it("restores HTML/title across navigation and clears a password", async () => {
    mockFetch({ ...ME, orgs: [] });
    const { router } = renderNew();
    fireEvent.change(await screen.findByLabelText("HTML"), {
      target: { value: "<title>Kept</title>" },
    });
    await userEvent.click(screen.getByRole("radio", { name: "Public link" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Require password" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "private-secret" } });
    void router.navigate({ to: "/teams" });
    await userEvent.click(
      await screen.findByRole("button", { name: "Keep preparation and leave" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/teams"));
    await waitFor(() => expect(screen.queryByLabelText("HTML")).not.toBeInTheDocument());
    void router.navigate({ to: "/new" });
    expect(await screen.findByLabelText("HTML")).toHaveValue("<title>Kept</title>");
    expect(screen.getByLabelText("Title")).toHaveValue("Kept");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });
  it("does not reveal or revive preparation after the authenticated account changes", async () => {
    mockFetch();
    const { qc } = renderNew();
    fireEvent.change(await screen.findByLabelText("HTML"), {
      target: { value: "private account content" },
    });
    await act(async () => {
      qc.setQueryData(["me"], { ...ME, id: "other" });
    });
    await waitFor(() => expect(screen.getByLabelText("HTML")).toHaveValue(""));
    await act(async () => {
      qc.setQueryData(["me"], ME);
    });
    expect(screen.getByLabelText("HTML")).toHaveValue("");
  });
  it("preserves folder paths and never calls live deployment endpoints", async () => {
    const calls = mockFetch();
    const upload = vi
      .spyOn(api, "uploadDraftFile")
      .mockResolvedValue(DRAFT as Awaited<ReturnType<typeof api.uploadDraftFile>>);
    renderNew("/new?method=folder");
    await screen.findByRole("button", { name: "Choose files" });
    const html = new File(["html"], "index.html");
    const css = new File(["css"], "app.css");
    Object.defineProperty(html, "webkitRelativePath", { value: "site/index.html" });
    Object.defineProperty(css, "webkitRelativePath", { value: "site/assets/app.css" });
    chooseFiles([html, css]);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await screen.findByRole("heading", { name: "Your draft is ready" });
    expect(upload.mock.calls.map((call) => call[1])).toEqual(["index.html", "assets/app.css"]);
    expect(calls.some((c) => /deploy|paste|publish/.test(c.path))).toBe(false);
  });
  it("unpacks a standalone ZIP before drafting and preserves ZIP assets inside folders", async () => {
    mockFetch();
    const upload = vi
      .spyOn(api, "uploadDraftFile")
      .mockResolvedValue(DRAFT as Awaited<ReturnType<typeof api.uploadDraftFile>>);
    renderNew("/new?method=zip");
    await screen.findByRole("button", { name: "Choose files" });
    const zip = new File([], "site.zip");
    const bytes = zipSync(
      {
        "index.html": strToU8("html"),
        "assets/data.zip": strToU8("asset"),
        "assets/photo.bin": new Uint8Array(21 * 1024 * 1024),
      },
      { level: 1 },
    );
    Object.defineProperty(zip, "size", { value: bytes.length });
    Object.defineProperty(zip, "arrayBuffer", { value: async () => bytes.buffer });
    chooseFiles([zip]);
    await userEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await screen.findByRole("heading", { name: "Your draft is ready" });
    expect(upload.mock.calls.map((call) => call[1])).toEqual([
      "assets/data.zip",
      "assets/photo.bin",
      "index.html",
    ]);
    expect(upload.mock.calls.find((call) => call[1] === "assets/photo.bin")?.[2].size).toBe(
      21 * 1024 * 1024,
    );
  });
  it("retains selected files and reuses the partial draft after an upload failure", async () => {
    const calls = mockFetch();
    vi.spyOn(api, "getDraft")
      .mockResolvedValueOnce({ ...DRAFT, files: [] })
      .mockResolvedValue(DRAFT);
    const upload = vi
      .spyOn(api, "uploadDraftFile")
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue(DRAFT as Awaited<ReturnType<typeof api.uploadDraftFile>>);
    renderNew("/new?method=folder");
    await screen.findByRole("button", { name: "Choose files" });
    chooseFiles([new File(["html"], "index.html")]);
    await userEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText(/Offline/)).toBeVisible();
    expect(screen.getByText("index.html")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry draft upload" }));
    await screen.findByRole("heading", { name: "Your draft is ready" });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/canvases")).toHaveLength(1);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
  it.each([true, false])(
    "resumes an uncertain upload after navigation only when its hash matches (%s)",
    async (matches) => {
      vi.stubGlobal("crypto", webcrypto);
      const calls = mockFetch();
      const available = vi.spyOn(api, "slugAvailable").mockResolvedValue({ available: true });
      const html = new File(["html"], "index.html");
      Object.defineProperty(html, "arrayBuffer", {
        value: async () => new TextEncoder().encode("html").buffer,
      });
      const hash = createHash("sha256").update("html").digest("hex");
      vi.spyOn(api, "getDraft").mockResolvedValue({
        ...DRAFT,
        files: [
          { path: "index.html", mime: "text/html", size: 4, hash: matches ? hash : "another-edit" },
        ],
      });
      const upload = vi
        .spyOn(api, "uploadDraftFile")
        .mockRejectedValueOnce(new Error("Response lost"))
        .mockResolvedValue(DRAFT);
      const { router } = renderNew("/new?method=folder");
      await screen.findByRole("button", { name: "Choose files" });
      chooseFiles([html, new File(["css"], "site.css")]);
      await userEvent.click(screen.getByText("Optional settings"));
      fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "my-draft" } });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Create draft" })).toBeEnabled(),
      );
      await userEvent.click(screen.getByRole("button", { name: "Create draft" }));
      await screen.findByText(/Response lost/);
      available.mockResolvedValue({ available: false, reason: "taken" });
      void router.navigate({ to: "/teams" });
      await userEvent.click(
        await screen.findByRole("button", { name: "Keep preparation and leave" }),
      );
      await waitFor(() => expect(router.state.location.pathname).toBe("/teams"));
      await waitFor(() => expect(screen.queryByText("Retry draft upload")).not.toBeInTheDocument());
      await waitFor(() => expect(router.state.isLoading).toBe(false));
      void router.navigate({ to: "/new" });
      await userEvent.click(await screen.findByRole("button", { name: "Retry draft upload" }));
      if (!matches) {
        await screen.findByText(/changed in the saved draft/);
        expect(upload).toHaveBeenCalledTimes(1);
        expect(calls.filter((c) => c.method === "POST" && c.path === "/api/canvases")).toHaveLength(
          1,
        );
        return;
      }
      await screen.findByRole("heading", { name: "Your draft is ready" });
      expect(upload.mock.calls.map((call) => call[1])).toEqual(["index.html", "site.css"]);
      expect(calls.filter((c) => c.method === "POST" && c.path === "/api/canvases")).toHaveLength(
        1,
      );
    },
  );
  it("retains the form across a failed refresh of cached account information", async () => {
    mockFetch();
    const { qc } = renderNew();
    fireEvent.change(await screen.findByLabelText("HTML"), { target: { value: "Keep this" } });
    vi.mocked(fetch).mockRejectedValue(new Error("Offline"));
    void qc.refetchQueries({ queryKey: ["me"] });
    await screen.findByText(/Workspace information couldn’t load/);
    expect(screen.getByLabelText("HTML")).toHaveValue("Keep this");
  });
  it("creates a canvas for API use without applying prior sharing choices", async () => {
    const calls = mockFetch();
    renderNew();
    await userEvent.click(await screen.findByRole("radio", { name: "Everyone in Acme" }));
    await userEvent.click(screen.getByRole("button", { name: "Use the API" }));
    await userEvent.click(screen.getByRole("button", { name: "Create canvas" }));
    expect(
      await screen.findByRole("heading", { name: "Your canvas is ready for the API" }),
    ).toBeVisible();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});
