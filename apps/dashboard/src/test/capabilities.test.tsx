import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { emptyPolicy } from "../lib/runtime-policy.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

const BASE = {
  id: "c1",
  slug: "quiet-otter",
  url: "http://x/c/quiet-otter",
  title: "My Canvas",
  description: null,
  shared: false,
  sharedExpiresAt: null,
  hasPassword: false,
  spaFallback: false,
  previewMode: "auto",
  galleryListed: false,
  tags: null,
  status: "active",
  publicationState: "draft",
  disabledReason: null,
  currentVersionId: null,
  createdAt: 0,
  updatedAt: 0,
};

const OFF = {
  ...BASE,
  backendEnabled: false,
  capabilities: { kv: true, files: true, ai: true, realtime: true },
  effective: { identity: false, kv: false, files: false, ai: false, realtime: false },
};

const ON = {
  ...BASE,
  backendEnabled: true,
  capabilities: { kv: true, files: true, ai: true, realtime: true },
  effective: { identity: true, kv: true, files: true, ai: true, realtime: true },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handlers: Record<string, () => Response | Promise<Response>>) {
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

function renderCapabilities(
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  initialEntries = ["/canvases/c1/capabilities"],
  historyOverride?: ReturnType<typeof createMemoryHistory>,
) {
  const router = createRouter({
    routeTree,
    history: historyOverride ?? createMemoryHistory({ initialEntries }),
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
  return Object.assign(qc, { testRouter: router });
}

let browserHistory: ReturnType<typeof createBrowserHistory> | undefined;
afterEach(() => {
  browserHistory?.destroy();
  browserHistory = undefined;
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("capabilities tab", () => {
  it.each([true, false])(
    "keeps cached canvas B unchanged after A's delayed capability result (success: %s)",
    async (success) => {
      let finish: ((response: Response) => void) | undefined;
      const pending = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const a = { ...ON, title: "Canvas A" };
      const b = { ...ON, id: "c2", title: "Canvas B", aiAudience: "viewers", role: "editor" };
      mockFetch({
        "GET /api/canvases/c1": () => json(a),
        "GET /api/canvases/c2": () => json(b),
        "GET /api/canvases/c1/connections": () => json({ connections: [] }),
        "GET /api/canvases/c2/connections": () => json({ connections: [] }),
        "PATCH /api/canvases/c1/capabilities": () => pending,
      });
      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      qc.setQueryData(["canvas", "c1"], a);
      qc.setQueryData(["canvas", "c2"], b);
      const { testRouter: router } = renderCapabilities(qc);
      await userEvent.click(await screen.findByRole("switch", { name: "AI" }));
      await router.navigate({ to: "/canvases/$id/capabilities", params: { id: "c2" } });
      await screen.findByRole("heading", { name: "Canvas B" });
      await act(async () => {
        finish?.(
          success
            ? json({ ...a, capabilities: { ...a.capabilities, ai: false } })
            : json({ error: "unavailable" }, 503),
        );
        await pending;
      });
      await vi.waitFor(() => expect(qc.isMutating()).toBe(0));
      expect(qc.getQueryData(["canvas", "c2"])).toEqual(b);
      expect(qc.getQueryData(["canvas", "c1"])).toMatchObject({ id: "c1" });
      expect(screen.getByRole("heading", { name: "Canvas B" })).toBeVisible();
      expect(screen.getByLabelText("AI access")).toHaveValue("viewers");
    },
  );

  it("discards policy A when going Back to cached canvas B and saves only B's proposal", async () => {
    const a = { ...ON, runtimePolicyRevision: null, runtimePolicy: emptyPolicy() };
    const b = {
      ...ON,
      id: "c2",
      title: "Canvas B",
      runtimePolicyRevision: null,
      runtimePolicy: {
        ...emptyPolicy(),
        defaultMode: "read_only",
        collections: { b_record: { preset: "managed" } },
      },
    };
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(a),
      "GET /api/canvases/c2": () => json(b),
      "GET /api/canvases/c1/connections": () => json({ connections: [] }),
      "GET /api/canvases/c2/connections": () => json({ connections: [] }),
      "PATCH /api/canvases/c2/capabilities": () => json(b),
    });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    qc.setQueryData(["canvas", "c1"], a);
    qc.setQueryData(["canvas", "c2"], b);
    // Memory history skips blockers on BACK; browser history exercises popstate
    // and the same blocker the browser Back button uses.
    window.history.replaceState(null, "", "/canvases/c2/capabilities");
    browserHistory = createBrowserHistory();
    browserHistory.push("/canvases/c1/capabilities");
    const { testRouter: router } = renderCapabilities(qc, undefined, browserHistory);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Resource name"), "a_only");
    await user.click(screen.getByRole("button", { name: "Add resource" }));
    router.history.back();
    await user.click(await screen.findByRole("button", { name: "Discard and leave" }));
    await screen.findByRole("heading", { name: "Canvas B" });
    expect(screen.getByLabelText("Default for new resources")).toHaveValue("read_only");
    expect(screen.queryByRole("button", { name: "Save permissions" })).not.toBeInTheDocument();
    expect(screen.queryByText(/a_only/)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Default for new resources"), "collaboration");
    await user.click(screen.getByRole("button", { name: "Save permissions" }));
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    const saved = calls.find((c) => c.method === "PATCH");
    expect(saved?.url).toBe("/api/canvases/c2/capabilities");
    expect(JSON.parse(saved?.body ?? "{}").runtimePolicy.collections).toEqual({
      b_record: { preset: "managed" },
    });
    expect(qc.getQueryData(["canvas", "c1"])).toEqual(a);
  });

  it("retains a pending policy and its revision if another session turns Backend off", async () => {
    let backendEnabled = true;
    const calls = mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...ON,
          backendEnabled,
          runtimePolicyRevision: backendEnabled ? "original" : "later",
        }),
      "GET /api/canvases/c1/connections": () => json({ connections: [] }),
      "PATCH /api/canvases/c1/capabilities": () => json({ ...ON, runtimePolicyRevision: "saved" }),
    });
    const qc = renderCapabilities();
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByLabelText("Default for new resources"),
      "collaboration",
    );
    backendEnabled = false;
    await qc.invalidateQueries({ queryKey: ["canvas", "c1"] });
    expect(await screen.findByText(/Backend was turned off/)).toBeVisible();
    expect(screen.getByLabelText("Default for new resources")).toHaveValue("collaboration");
    expect(screen.getByRole("button", { name: "Save permissions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard changes" })).not.toBeDisabled();
    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(
      await screen.findByRole("dialog", { name: "Leave with unsaved changes?" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    backendEnabled = true;
    await qc.invalidateQueries({ queryKey: ["canvas", "c1"] });
    await user.click(screen.getByRole("button", { name: "Save permissions" }));
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    expect(
      JSON.parse(calls.find((c) => c.method === "PATCH")?.body ?? "{}").expectedRuntimePolicy,
    ).toBe("original");
  });

  it("protects a failed policy proposal when leaving or disabling Backend", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(ON),
      "GET /api/canvases/c1/connections": () => json({ connections: [] }),
      "PATCH /api/canvases/c1/capabilities": () => json({ error: "POLICY_CONFLICT" }, 409),
    });
    renderCapabilities();
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByLabelText("Default for new resources"),
      "collaboration",
    );
    expect(screen.getByRole("switch", { name: "Enable backend" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save permissions" }));
    expect(await screen.findByText(/your proposed changes are still shown/)).toBeVisible();
    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(
      await screen.findByRole("dialog", { name: "Leave with unsaved changes?" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Default for new resources")).toHaveValue("collaboration");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("switch", { name: "Enable backend" })).not.toBeDisabled();
  });

  it("backend off: explains the static state and discloses retained settings", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json(OFF) });
    renderCapabilities();
    expect(await screen.findByRole("switch", { name: "Enable backend" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("link", { name: "SDK docs" })).toHaveAttribute("href", "/docs");
    expect(screen.getByText("This canvas is static")).toBeVisible();
    expect(screen.queryByRole("switch", { name: "AI" })).not.toBeInTheDocument();
    expect(screen.getByText("Review saved configuration").parentElement).not.toHaveAttribute(
      "open",
    );
    await userEvent.click(screen.getByText("Review saved configuration"));
    expect(screen.getByText(/These preferences are retained/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Add resource" })).toBeDisabled();
  });

  it("enabling backend PATCHes backendEnabled:true", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(OFF),
      "PATCH /api/canvases/c1/capabilities": () => json(ON),
    });
    const user = userEvent.setup();
    renderCapabilities();
    await user.click(await screen.findByRole("switch", { name: "Enable backend" }));
    await vi.waitFor(() => {
      const patch = calls.find((c) => c.url === "/api/canvases/c1/capabilities");
      expect(patch?.method).toBe("PATCH");
      expect(patch?.body).toContain('"backendEnabled":true');
    });
  });

  it("backend on: toggling a feature off PATCHes that flag", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(ON),
      "PATCH /api/canvases/c1/capabilities": () =>
        json({ ...ON, capabilities: { ...ON.capabilities, ai: false } }),
    });
    const user = userEvent.setup();
    renderCapabilities();
    const ai = await screen.findByRole("switch", { name: "AI" });
    expect(ai).not.toBeDisabled();
    await user.click(ai);
    await vi.waitFor(() => {
      const patch = calls.find((c) => c.url === "/api/canvases/c1/capabilities");
      expect(patch?.body).toContain('"ai":false');
    });
  });

  it("shows an operator-disabled hint when a stored feature is not effective", async () => {
    const gated = {
      ...ON,
      capabilities: { ...ON.capabilities, realtime: true },
      effective: { ...ON.effective, realtime: false },
    };
    mockFetch({ "GET /api/canvases/c1": () => json(gated) });
    renderCapabilities();
    expect(await screen.findByText(/disabled by your administrator/i)).toBeInTheDocument();
  });

  it("identity reads Always on when backend is enabled", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json(ON) });
    renderCapabilities();
    expect(await screen.findByText("Always on")).toBeInTheDocument();
  });

  it("warns that backend is inert when a public_link canvas has backend enabled", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json({ ...ON, access: "public_link" }) });
    renderCapabilities();
    expect(await screen.findByText(/Public-link viewers have static access/i)).toBeInTheDocument();
  });

  it("does NOT show the public-backend warning on a non-public canvas", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json({ ...ON, access: "private" }) });
    renderCapabilities();
    await screen.findByRole("switch", { name: "Enable backend" });
    expect(screen.queryByText(/Public-link viewers have static access/i)).not.toBeInTheDocument();
  });

  it("shows sanitized admin-granted connection authority without mutation controls", async () => {
    mockFetch({
      "GET /api/canvases/c1": () => json(ON),
      "GET /api/canvases/c1/connections": () =>
        json({
          connections: [
            {
              key: "stocks",
              label: "Stock data",
              origin: "https://stocks.example.com",
              allowedMethods: ["GET"],
              available: true,
              unavailableReason: null,
            },
          ],
        }),
    });
    renderCapabilities();
    expect(await screen.findByText("Stock data")).toBeInTheDocument();
    expect(screen.getByText("https://stocks.example.com")).toBeInTheDocument();
    expect(screen.getByText("Methods: GET")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /grant|revoke|edit/i })).not.toBeInTheDocument();
  });
});

it("lets an editor explicitly enable AI for viewers and preserves the connection audience", async () => {
  const calls = mockFetch({
    "GET /api/canvases/c1": () =>
      json({ ...ON, role: "editor", aiAudience: "editors", connectionsAudience: "editors" }),
    "PATCH /api/canvases/c1/capabilities": () =>
      json({ ...ON, aiAudience: "viewers", connectionsAudience: "editors" }),
  });
  renderCapabilities();
  const select = await screen.findByRole("combobox", { name: "AI access" });
  expect(select).toHaveValue("editors");
  await userEvent.selectOptions(select, "viewers");
  await vi.waitFor(() =>
    expect(calls.find((call) => call.method === "PATCH")?.body).toBe(
      JSON.stringify({ aiAudience: "viewers" }),
    ),
  );
  expect(screen.getByRole("combobox", { name: "Connection access" })).toHaveValue("editors");
});

it("lets an editor limit page-driven authoring to owners and editors", async () => {
  const calls = mockFetch({
    "GET /api/canvases/c1": () =>
      json({ ...ON, role: "editor", aiAudience: "editors", connectionsAudience: "editors" }),
    "PATCH /api/canvases/c1/capabilities": () =>
      json({
        ...ON,
        aiAudience: "editors",
        connectionsAudience: "editors",
        authoringAudience: "editors",
      }),
  });
  renderCapabilities();
  const select = await screen.findByRole("combobox", { name: "Authoring access" });
  // Absent on a legacy payload reads as every admitted viewer, the historical behaviour.
  expect(select).toHaveValue("viewers");
  await userEvent.selectOptions(select, "editors");
  await vi.waitFor(() =>
    expect(calls.find((call) => call.method === "PATCH")?.body).toBe(
      JSON.stringify({ authoringAudience: "editors" }),
    ),
  );
  expect(screen.getByRole("combobox", { name: "AI access" })).toHaveValue("editors");
});
