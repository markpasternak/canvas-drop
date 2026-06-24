import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

const ME = {
  id: "u1",
  email: "me@example.com",
  name: "Me",
  avatarUrl: null,
  isAdmin: false,
  canPublishPublic: false,
  authMode: "dev",
  orgs: [{ id: "o1", name: "Acme" }],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch() {
  const calls: { method: string; pathname: string; search: string }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const parsed = new URL(url, "http://localhost");
    calls.push({ method, pathname: parsed.pathname, search: parsed.search });
    if (method === "GET" && parsed.pathname === "/api/me") return json(ME);
    if (method === "GET" && parsed.pathname === "/api/canvases/shared") {
      return json({
        canvases: [
          {
            id: "c1",
            slug: "team-thing",
            url: "http://x/c/team-thing",
            title: "Team Thing",
            description: "A team canvas",
            tags: ["handoff"],
            access: { kind: "team", label: "Design", teamIds: ["t1"], teamNames: ["Design"] },
            hasPassword: false,
            hasPreview: false,
            owner: { id: "u2", name: "Colleague", avatarUrl: null },
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        total: 31,
        limit: 30,
        offset: 30,
      });
    }
    return json({ error: "not_mocked" }, 500);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function renderShared() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: ["/shared?q=design&sort=owner&page=2&view=list"],
    }),
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared page", () => {
  it("renders searchable paged shared canvases in list mode", async () => {
    const calls = mockFetch();
    const user = userEvent.setup();
    renderShared();

    const link = await screen.findByRole("link", { name: "Team Thing" });
    expect(link).toHaveAttribute("href", "http://x/c/team-thing");
    const row = link.closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Design")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("Design · Colleague")).toBeInTheDocument();
    expect(screen.getByText("Showing 31-31 of 31")).toBeInTheDocument();

    await vi.waitFor(() => {
      expect(calls).toContainEqual({
        method: "GET",
        pathname: "/api/canvases/shared",
        search: "?q=design&sort=owner&limit=30&offset=30",
      });
    });

    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous" }));
    await vi.waitFor(() => {
      expect(calls).toContainEqual({
        method: "GET",
        pathname: "/api/canvases/shared",
        search: "?q=design&sort=owner&limit=30&offset=0",
      });
    });

    await user.click(screen.getByRole("combobox", { name: "Sort shared canvases" }));
    await user.click(screen.getByRole("option", { name: "Title A-Z" }));
    await vi.waitFor(() => {
      expect(calls).toContainEqual({
        method: "GET",
        pathname: "/api/canvases/shared",
        search: "?q=design&sort=title&limit=30&offset=0",
      });
    });
  });
});
