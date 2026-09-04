import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { api } from "../lib/api.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

const ME = {
  id: "u1",
  email: "owner@example.com",
  name: "Owner",
  avatarUrl: null,
  isAdmin: false,
  canPublishPublic: true,
  authMode: "dev",
  urlMode: "path",
  baseUrl: "http://localhost:3000",
  designSkin: "editorial",
  orgs: [{ id: "org1", name: "Acme" }],
  isGuest: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(me = ME, failSettings = false) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw, "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === "/api/me") return json(me);
      if (url.pathname === "/api/canvases/paste" && method === "POST") {
        return json({ id: "c1", apiKey: "cd_once", url: "http://x/c/new", deploy: {} });
      }
      if (url.pathname === "/api/canvases" && method === "POST") {
        return json({ id: "c1", apiKey: "cd_once", url: "http://x/c/new" });
      }
      if (url.pathname === "/api/canvases/c1/settings" && method === "PATCH") {
        return failSettings
          ? json({ code: "SHARE_FAILED", message: "sharing unavailable" }, 500)
          : json({ id: "c1" });
      }
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
          {/* biome-ignore lint/suspicious/noExplicitAny: test router instance */}
          <RouterProvider router={router as any} />
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return router;
}

afterEach(() => vi.unstubAllGlobals());

describe("Create canvas — audience shortcut", () => {
  it("defaults to Restricted, reveals workspace listing, and applies it after publish", async () => {
    const calls = mockFetch();
    renderNew();

    expect(await screen.findByRole("heading", { name: "Audience" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Restricted" })).toBeChecked();
    expect(
      screen.getByText("Only you and people or teams you add can open it."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Everyone in Acme" }));
    const listed = screen.getByRole("checkbox", { name: "List in Shared" });
    expect(listed).not.toBeChecked();
    await userEvent.click(listed);
    await userEvent.type(screen.getByLabelText("HTML"), "<h1>Hello</h1>");
    await userEvent.click(screen.getByRole("button", { name: "Create and publish" }));

    expect(
      await screen.findByRole("heading", { name: "Your canvas is published" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Everyone in Acme")).toBeVisible();
    const writeCalls = calls.filter((call) => call.method !== "GET");
    expect(writeCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/canvases/paste",
      "PATCH /api/canvases/c1/settings",
    ]);
    expect(writeCalls[1]?.body).toEqual({
      access: "whole_org",
      discoverability: "listed",
    });
  });

  it("resets to Restricted when destination changes and explains a disabled public link", async () => {
    mockFetch({ ...ME, canPublishPublic: false });
    renderNew();

    await screen.findByRole("heading", { name: "Audience" });
    await userEvent.click(screen.getByRole("radio", { name: "Everyone in Acme" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /workspace/i }), "");

    expect(screen.getByRole("radio", { name: "Restricted" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Public link" })).toBeDisabled();
    expect(screen.getByText(/public links are unavailable for your account/i)).toBeInTheDocument();
  });

  it("keeps a published canvas Restricted when sharing fails and sends recovery to Share", async () => {
    const calls = mockFetch({ ...ME, orgs: [] }, true);
    const router = renderNew();

    await screen.findByRole("heading", { name: "Audience" });
    await userEvent.click(screen.getByRole("radio", { name: "Public link" }));
    await userEvent.type(screen.getByLabelText("HTML"), "<h1>Hello</h1>");
    await userEvent.click(screen.getByRole("button", { name: "Create and publish" }));

    expect(
      await screen.findByText(/canvas is published and still Restricted/i),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await userEvent.click(
      screen.getByRole("button", { name: "Continue without saving · Open Share" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/canvases/c1/share"));
  });

  it("hides Audience for API creation and never submits prior sharing state", async () => {
    const calls = mockFetch();
    renderNew();

    await screen.findByRole("heading", { name: "Audience" });
    await userEvent.click(screen.getByRole("radio", { name: "Everyone in Acme" }));
    await userEvent.click(screen.getByRole("button", { name: /use the api/i }));
    expect(screen.queryByRole("heading", { name: "Audience" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create key" }));

    await waitFor(() =>
      expect(calls.some((call) => call.method === "POST" && call.path === "/api/canvases")).toBe(
        true,
      ),
    );
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });
});

const DEPLOYED = { url: "http://x/c/new", version: 1, fileCount: 2, totalBytes: 50, warnings: [] };
function chooseFiles(files: File[]) {
  const input = document.querySelector<HTMLInputElement>(
    'input[type="file"]:not([webkitdirectory])',
  );
  if (!input) throw new Error("Missing file picker");
  fireEvent.change(input, { target: { files } });
}

describe("Create canvas — content and result", () => {
  it("suggests the HTML title but preserves an edited title across subsequent changes", async () => {
    const calls = mockFetch();
    renderNew();
    const html = await screen.findByLabelText("HTML");
    fireEvent.change(html, { target: { value: "<title>Team roadmap</title><h1>First</h1>" } });
    expect(screen.getByLabelText("Title")).toHaveValue("Team roadmap");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Our next release" } });
    fireEvent.change(html, { target: { value: "<title>Changed title</title><h1>Second</h1>" } });
    expect(screen.getByLabelText("Title")).toHaveValue("Our next release");
    const preview = screen.getByTitle("HTML document preview");
    expect(preview).toHaveAttribute("sandbox", "");
    expect(preview.getAttribute("srcdoc")).toContain("Second");
    expect(preview.getAttribute("srcdoc")).not.toContain("First");
    await userEvent.click(screen.getByRole("button", { name: "Create and publish" }));
    await screen.findByRole("heading", { name: "Your canvas is published" });
    expect(calls.find((c) => c.path === "/api/canvases/paste")?.body).toMatchObject({
      title: "Our next release",
      orgId: "org1",
    });
  });

  it("reviews a folder before publishing and preserves relative paths", async () => {
    const calls = mockFetch();
    const deploy = vi.spyOn(api, "deployFolder").mockResolvedValue(DEPLOYED);
    renderNew("/new?method=folder");
    await screen.findByRole("button", { name: "Choose files" });
    const index = new File(["<h1>Hello</h1>"], "index.html");
    const css = new File(["body{color:red}"], "app.css");
    Object.defineProperty(index, "webkitRelativePath", { value: "site/index.html" });
    Object.defineProperty(css, "webkitRelativePath", { value: "site/assets/app.css" });
    chooseFiles([index, css]);
    expect(screen.getByText("assets/app.css")).toBeVisible();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(deploy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Create and publish" }));
    await screen.findByRole("heading", { name: "Your canvas is published" });
    expect([...(deploy.mock.calls[0]?.[1].keys() ?? [])]).toEqual(["index.html", "assets/app.css"]);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeVisible();
    expect(screen.getByText("Restricted · Only you can open it")).toBeVisible();
  });

  it("honors legacy ZIP links and dispatches only after explicit publish", async () => {
    const calls = mockFetch();
    const deploy = vi.spyOn(api, "deployZip").mockResolvedValue(DEPLOYED);
    renderNew("/new?method=zip");
    await screen.findByRole("button", { name: "Choose files" });
    const file = new File(["zip"], "site.zip");
    const bytes = new ArrayBuffer(3);
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes });
    chooseFiles([file]);
    expect(screen.getByText("ZIP archive ready")).toBeVisible();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Create and publish" }));
    await screen.findByRole("heading", { name: "Your canvas is published" });
    expect(deploy).toHaveBeenCalledWith("c1", bytes, expect.any(Function));
  });

  it("clears an old selection when a mixed archive selection is invalid", async () => {
    const calls = mockFetch();
    renderNew("/new?method=folder");
    await screen.findByRole("button", { name: "Choose files" });
    chooseFiles([new File(["html"], "index.html")]);
    chooseFiles([new File(["zip"], "site.zip"), new File(["html"], "index.html")]);
    expect(screen.getByText(/Choose one non-empty ZIP/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Create and publish" })).toBeDisabled();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("cleans up a failed upload and allows retrying the selected files", async () => {
    const calls = mockFetch();
    vi.spyOn(api, "deployFolder").mockRejectedValue(new Error("upload failed"));
    renderNew("/new?method=folder");
    await screen.findByRole("button", { name: "Choose files" });
    chooseFiles([new File(["html"], "index.html")]);
    await userEvent.click(screen.getByRole("button", { name: "Create and publish" }));
    await screen.findByText("Something went wrong. Try again.");
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/canvases",
      "DELETE /api/canvases/c1",
    ]);
    expect(screen.getByRole("button", { name: "Create and publish" })).toBeEnabled();
    expect(screen.getByText("index.html")).toBeVisible();
  });

  it("freezes content, destination and source while publishing and prevents a duplicate request", async () => {
    const calls = mockFetch();
    let resolve!: (value: Awaited<ReturnType<typeof api.pasteHtml>>) => void;
    const paste = vi.spyOn(api, "pasteHtml").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    renderNew();
    fireEvent.change(await screen.findByLabelText("HTML"), { target: { value: "<h1>Hello</h1>" } });
    const publish = screen.getByRole("button", { name: "Create and publish" });
    await userEvent.dblClick(publish);
    expect(paste).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("HTML")).toBeDisabled();
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /workspace/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Everyone in Acme" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Upload files" })).toBeDisabled();
    // The server response is sufficient for the result; all other Canvas fields are unused here.
    resolve({ id: "c1", apiKey: "cd_once", url: "http://x/c/new" } as Awaited<
      ReturnType<typeof api.pasteHtml>
    >);
    await screen.findByRole("heading", { name: "Your canvas is published" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("lets the user explicitly skip the key, without storing it", async () => {
    mockFetch();
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const router = renderNew();
    fireEvent.change(await screen.findByLabelText("HTML"), { target: { value: "<h1>Hello</h1>" } });
    await userEvent.click(screen.getByRole("button", { name: "Create and publish" }));
    await screen.findByRole("heading", { name: "Your canvas is published" });
    expect(screen.getByRole("link", { name: /Open canvas/ })).toHaveAttribute("target", "_blank");
    await userEvent.click(screen.getByRole("button", { name: "Continue without saving the key" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/canvases/c1"));
    expect(
      storage.mock.calls.some((call) => call.some((value) => String(value).includes("cd_once"))),
    ).toBe(false);
    expect(document.body.textContent).not.toContain("cd_once");
  });
});
