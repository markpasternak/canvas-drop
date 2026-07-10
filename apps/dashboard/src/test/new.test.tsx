import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
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

function renderNew() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/new"] }),
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
  it("defaults private, reveals workspace listing, and applies it after publish", async () => {
    const calls = mockFetch();
    renderNew();

    expect(await screen.findByRole("heading", { name: "Audience" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Only me" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Everyone in Acme" }));
    const listed = screen.getByRole("checkbox", { name: "List in Shared" });
    expect(listed).not.toBeChecked();
    await userEvent.click(listed);
    await userEvent.type(screen.getByLabelText("HTML"), "<h1>Hello</h1>");
    await userEvent.click(screen.getByRole("button", { name: "Create and publish" }));

    expect(await screen.findByText("Save your canvas key")).toBeInTheDocument();
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

  it("resets to Only me when destination changes and explains a disabled public link", async () => {
    mockFetch({ ...ME, canPublishPublic: false });
    renderNew();

    await screen.findByRole("heading", { name: "Audience" });
    await userEvent.click(screen.getByRole("radio", { name: "Everyone in Acme" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /workspace/i }), "");

    expect(screen.getByRole("radio", { name: "Only me" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Public link" })).toBeDisabled();
    expect(screen.getByText(/public links are unavailable for your account/i)).toBeInTheDocument();
  });

  it("keeps a published canvas private when sharing fails and sends recovery to Share", async () => {
    const calls = mockFetch({ ...ME, orgs: [] }, true);
    const router = renderNew();

    await screen.findByRole("heading", { name: "Audience" });
    await userEvent.click(screen.getByRole("radio", { name: "Public link" }));
    await userEvent.type(screen.getByLabelText("HTML"), "<h1>Hello</h1>");
    await userEvent.click(screen.getByRole("button", { name: "Create and publish" }));

    expect(await screen.findByText(/canvas is published and still private/i)).toBeInTheDocument();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Save key and open Share" }));
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
