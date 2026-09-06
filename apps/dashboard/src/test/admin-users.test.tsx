import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Handler = (init?: RequestInit) => Response;
const calls: Array<{ method: string; path: string }> = [];

function mockFetch(handlers: Record<string, Handler>) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const u = new URL(url, "http://localhost");
      calls.push({ method, path: u.pathname + u.search });
      return (
        handlers[`${method} ${u.pathname}${u.search}`]?.(init) ??
        handlers[`${method} ${u.pathname}`]?.(init) ??
        json({ error: "not_mocked" }, 500)
      );
    }),
  );
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
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

const ME = { id: "u-me", email: "me@x", name: "Me", avatarUrl: null, isAdmin: true };
const personRow = (over: Record<string, unknown>) => ({
  email: "bob@example.com",
  kind: "external",
  orgMember: false,
  userId: "u-bob",
  name: "Bob",
  avatarUrl: null,
  isAdmin: false,
  isBlocked: false,
  canPublishPublic: true,
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  canvasCount: 1,
  permitId: null,
  permitCreatedAt: null,
  permitCreatedBy: null,
  pendingCount: 0,
  pendingCanvasCount: 0,
  pendingTeamCount: 0,
  pendingGrants: [],
  ...over,
});

function peoplePage(people: unknown[]) {
  return json({ people, total: people.length, limit: 50, offset: 0 });
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("admin users", () => {
  const offboardingPreview = {
    email: "bob@example.com",
    fingerprint: "preview-1",
    self: false,
    user: null,
    recipient: null,
    owned: [],
    direct: [],
    memberships: [],
    organizations: [],
    createdTeams: [],
    permits: [{ id: "permit-1" }],
    pending: [{ id: "invite-1", targetId: "canvas-1", targetType: "canvas", role: "viewer" }],
  };

  it("requires confirmation and keeps pending-only results visible after the person leaves the directory", async () => {
    let removed = false;
    let submitted: unknown;
    mockFetch({
      "GET /api/me": () => json(ME),
      "GET /api/admin/people": () =>
        peoplePage(removed ? [] : [personRow({ userId: null, kind: "pending", name: null })]),
      "GET /api/admin/users": () => json({ users: [] }),
      "POST /api/admin/people/offboarding/preview": () => json(offboardingPreview),
      "POST /api/admin/people/offboarding/execute": (init) => {
        submitted = JSON.parse(init?.body as string);
        removed = true;
        return json({
          outcomes: [
            {
              id: "invite-1",
              kind: "invitation",
              label: "Canvas invitation",
              status: "done",
              message: "Completed",
            },
          ],
          unresolved: [],
          complete: true,
          accountBlocked: null,
        });
      },
    });
    renderAt("/admin/users?kind=pending");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Actions for bob@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: "Offboard person" }));
    const dialog = await screen.findByRole("dialog", { name: "Offboard bob@example.com" });
    const confirm = await within(dialog).findByRole("button", { name: "Confirm offboarding" });
    expect(confirm).toBeDisabled();
    expect(
      within(dialog).getByText(/does not create an account or a permanent email ban/),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Offboarding reason"), "Invitation withdrawn");
    await user.type(
      within(dialog).getByLabelText("Type OFFBOARD bob@example.com to confirm"),
      "OFFBOARD bob@example.com",
    );
    expect(submitted).toBeUndefined();
    await user.click(confirm);
    expect(await within(dialog).findByText("Offboarding complete")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("table")).not.toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(submitted).toEqual({
      email: "bob@example.com",
      fingerprint: "preview-1",
      reason: "Invitation withdrawn",
      confirmation: "OFFBOARD bob@example.com",
    });
  });

  it("refreshes the impact after choosing a successor and reports unresolved results", async () => {
    let submitted: { toUserId?: string; fingerprint?: string } | undefined;
    mockFetch({
      "GET /api/me": () => json(ME),
      "GET /api/admin/people": () => peoplePage([personRow({})]),
      "GET /api/admin/users": () =>
        json({
          users: [{ id: "successor", name: "Alice", email: "alice@example.com", isBlocked: false }],
        }),
      "POST /api/admin/people/offboarding/preview": (init) => {
        const { toUserId } = JSON.parse(init?.body as string);
        return json({
          ...offboardingPreview,
          user: { id: "u-bob", name: "Bob", isBlocked: false },
          fingerprint: toUserId ? "preview-2" : "preview-1",
          recipient: toUserId ? { id: toUserId, email: "alice@example.com" } : null,
          owned: [
            {
              id: "canvas-1",
              title: "Important canvas",
              status: "active",
              transferEligible: !!toUserId,
              transferExplanation: toUserId ? null : "Choose a successor",
            },
          ],
        });
      },
      "POST /api/admin/people/offboarding/execute": (init) => {
        submitted = JSON.parse(init?.body as string);
        return json({
          complete: false,
          accountBlocked: true,
          outcomes: [
            {
              kind: "canvas",
              id: "canvas-1",
              label: "Important canvas",
              status: "failed",
              message: "Failed; review and retry",
            },
          ],
          unresolved: ["Ownership: Important canvas"],
        });
      },
    });
    renderAt("/admin/users");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Actions for Bob" }));
    await user.click(screen.getByRole("menuitem", { name: "Offboard person" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(await within(dialog).findByLabelText("Successor"), "alice");
    await user.click(
      await within(dialog).findByRole("button", { name: "Alice · alice@example.com" }),
    );
    expect(await within(dialog).findByText("Transfer to alice@example.com")).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Offboarding reason"), "Leaving");
    await user.type(
      within(dialog).getByLabelText("Type OFFBOARD bob@example.com to confirm"),
      "OFFBOARD bob@example.com",
    );
    await user.click(within(dialog).getByRole("button", { name: "Confirm offboarding" }));
    expect(await within(dialog).findByText("Offboarding needs follow-up")).toBeInTheDocument();
    expect(within(dialog).getByText("Ownership: Important canvas")).toBeInTheDocument();
    expect(submitted).toMatchObject({ toUserId: "successor", fingerprint: "preview-2" });
    expect(within(dialog).getByRole("button", { name: "Review a fresh preview" })).toBeEnabled();
  });
  it("renders the People table with canvas count, role, and status", async () => {
    mockFetch({
      "GET /api/me": () => json(ME),
      "GET /api/admin/people": () =>
        peoplePage([
          personRow({
            email: "me@x",
            name: "Me",
            userId: "u-me",
            kind: "org_member",
            orgMember: true,
            isAdmin: true,
            canvasCount: 3,
          }),
          personRow({}),
        ]),
    });
    renderAt("/admin/users");
    expect(await screen.findByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    // Role + status badges present (scope to the table — "Admin" is also a nav link).
    const table = screen.getByRole("table");
    expect(within(table).getByText("Admin")).toBeInTheDocument(); // the "Me" admin row
    expect(within(table).getAllByText("Active").length).toBeGreaterThanOrEqual(1);
    // Per-user owned-canvas count column.
    expect(within(table).getAllByText("3").length).toBeGreaterThanOrEqual(1);
  });

  it("blocks a user via the row action", async () => {
    mockFetch({
      "GET /api/me": () => json(ME),
      "GET /api/admin/people": () =>
        peoplePage([
          personRow({ email: "me@x", name: "Me", userId: "u-me", isAdmin: true }),
          personRow({}),
        ]),
      "POST /api/admin/users/u-bob/block": () => json({ ok: true }),
    });
    renderAt("/admin/users");
    const user = userEvent.setup();
    await screen.findByText("Bob");
    // Open Bob's row overflow menu (me's own row blocks itself), then Block —
    // which now confirms first (destructive action from a hover menu).
    await user.click(screen.getByRole("button", { name: "Actions for Bob" }));
    await user.click(await screen.findByRole("menuitem", { name: "Block user" }));
    const dialog = await screen.findByRole("dialog", { name: "Block Bob?" });
    await user.click(within(dialog).getByRole("button", { name: "Block" }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.path === "/api/admin/users/u-bob/block"),
      ).toBe(true),
    );
  });

  it("self-protection: your own row can't be blocked or demoted", async () => {
    mockFetch({
      "GET /api/me": () => json(ME),
      "GET /api/admin/people": () =>
        peoplePage([personRow({ email: "me@x", name: "Me", userId: "u-me", isAdmin: true })]),
    });
    renderAt("/admin/users");
    const user = userEvent.setup();
    // "Me" is the row's display name AND the signed-in account label shown in the
    // rail footer's account control, so scope the load wait to the user table.
    const table = await screen.findByRole("table");
    await within(table).findByText("Me");
    await user.click(screen.getByRole("button", { name: "Actions for Me" }));
    // Your own row's block + demote items are disabled (aria-disabled menuitems).
    expect(await screen.findByRole("menuitem", { name: "Block user" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "Remove admin access" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("cancels pending access from an email-only row", async () => {
    mockFetch({
      "GET /api/me": () => json(ME),
      "GET /api/admin/people": () =>
        peoplePage([
          personRow({
            email: "pending@partner.io",
            name: null,
            userId: null,
            kind: "pending",
            canPublishPublic: null,
            pendingCount: 1,
            pendingCanvasCount: 1,
            pendingGrants: [
              {
                id: "inv-1",
                targetType: "canvas",
                targetId: "c1",
                createdAt: Date.now(),
                invitedBy: "u-me",
              },
            ],
          }),
        ]),
      "DELETE /api/admin/people/invitations/inv-1": () => json({ ok: true }),
    });
    renderAt("/admin/users");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Actions for pending@partner.io" }));
    await user.click(await screen.findByRole("menuitem", { name: "Cancel pending access" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "DELETE" && c.path === "/api/admin/people/invitations/inv-1",
        ),
      ).toBe(true),
    );
  });
});
