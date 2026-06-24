import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
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

function mockFetch(handlers: Record<string, () => Response>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const defaults: Record<string, () => Response> = {
    "GET /api/me": () => json(ME),
    "GET /api/teams": () => json({ teams: [] }),
    "GET /api/people/search": () => json({ people: [] }),
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

function renderTeams() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/teams"] }),
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

describe("teams page", () => {
  it("a no-org user can create a PERSONAL team (no org id in the POST)", async () => {
    const calls = mockFetch({
      "GET /api/me": () => json({ ...ME, orgs: [] }),
      "POST /api/teams": () =>
        json({ team: { id: "t9", orgId: null, name: "Family", slug: "family" } }),
    });
    const user = userEvent.setup();
    renderTeams();

    // No org → no "Team type" selector; the create form is available straight away.
    expect(screen.queryByLabelText(/team type/i)).toBeNull();
    await user.type(await screen.findByLabelText(/new team name/i), "Family");
    await user.click(screen.getByRole("button", { name: /create team/i }));

    await vi.waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/teams");
      expect(post?.body).toContain("Family");
      expect(post?.body).toContain('"orgId":null');
    });
  });

  it("lists teams and creates an ORG team when the org type is chosen", async () => {
    const calls = mockFetch({
      "GET /api/teams": () =>
        json({
          teams: [
            {
              id: "t1",
              orgId: null,
              name: "Design",
              slug: "design",
              mine: true,
              canManage: true,
            },
          ],
        }),
      "POST /api/teams": () =>
        json({ team: { id: "t2", orgId: "o1", name: "Growth", slug: "growth" } }),
    });
    const user = userEvent.setup();
    renderTeams();

    expect(await screen.findByText("Design")).toBeInTheDocument();
    // An org member sees the Personal/Org selector; pick the org to attach the team.
    await user.selectOptions(await screen.findByLabelText(/team type/i), "o1");
    await user.type(await screen.findByLabelText(/new team name/i), "Growth");
    await user.click(screen.getByRole("button", { name: /create team/i }));

    await vi.waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/teams");
      expect(post?.body).toContain("Growth");
      expect(post?.body).toContain("o1");
    });
  });

  it("expands a team roster and adds a member; shows pending sign-ins", async () => {
    const calls = mockFetch({
      "GET /api/teams": () =>
        json({
          teams: [
            { id: "t1", orgId: "o1", name: "Design", slug: "design", mine: true, canManage: true },
          ],
        }),
      "GET /api/teams/t1/members": () =>
        json({
          members: [{ userId: "u2", email: "ada@example.com", name: "Ada Lovelace" }],
          pending: [{ email: "waiting@example.com", invitedAt: 1 }],
        }),
      "POST /api/teams/t1/members": () =>
        json({ ok: true, status: "pending", emailDelivery: { status: "sent" } }),
    });
    const user = userEvent.setup();
    renderTeams();

    await user.click(await screen.findByRole("button", { name: /^members$/i }));
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    // The pending invitee appears with a Pending sign-in badge (not yet a member).
    expect(await screen.findByText("waiting@example.com")).toBeInTheDocument();
    expect(screen.getByText(/pending sign-in/i)).toBeInTheDocument();

    await user.type(await screen.findByLabelText(/person's email/i), "new@example.com");
    await user.click(screen.getByRole("button", { name: /^add person$/i }));
    expect(
      await screen.findByText("Team access pending until sign-in. Email sent"),
    ).toBeInTheDocument();
    await vi.waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/teams/t1/members");
      expect(post?.body).toContain("new@example.com");
    });
  });

  it("does NOT offer rename/delete for a team the caller can't manage", async () => {
    mockFetch({
      "GET /api/teams": () =>
        json({
          teams: [
            { id: "t1", orgId: "o1", name: "Ops", slug: "ops", mine: false, canManage: false },
          ],
        }),
    });
    renderTeams();
    await screen.findByText("Ops");
    expect(screen.queryByRole("button", { name: /^delete$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^rename$/i })).toBeNull();
  });
});
