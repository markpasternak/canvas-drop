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
  access: "private",
  discoverability: "link_only",
  shared: false,
  guestAiEnabled: false,
  guestAiCap: 0,
  sharedExpiresAt: null,
  hasPassword: false,
  spaFallback: false,
  previewMode: "auto",
  teamIds: [],
  galleryListed: false,
  galleryTemplatable: false,
  tags: null,
  clonedFromCanvasId: null,
  status: "active",
  publicationState: "draft",
  disabledReason: null,
  currentVersionId: null,
  createdAt: 0,
  updatedAt: 0,
};

const ME = {
  id: "u1",
  email: "owner@example.com",
  name: "Owner",
  avatarUrl: null,
  isAdmin: false,
  canPublishPublic: false,
  authMode: "dev",
  // An org member (the Team rung is gated on org membership).
  orgs: [{ id: "o1", name: "Acme" }],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handlers: Record<string, () => Response | Promise<Response>>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const defaults: Record<string, () => Response> = {
    "GET /api/me": () => json(ME),
    // The share control loads the caller's teams for the Team rung picker (plan 003);
    // default to none so existing tests don't hit the unmocked fallback.
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

function renderShare() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/canvases/c1/share"] }),
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("share route", () => {
  it("sets a password via PATCH", async () => {
    const published = { ...CANVAS, publicationState: "published", currentVersionId: "v1" };
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "PATCH /api/canvases/c1/settings": () => json({ ...published, hasPassword: true }),
    });
    const user = userEvent.setup();
    renderShare();

    await user.type(await screen.findByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: /set password/i }));

    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch).toBeTruthy();
      expect(patch?.body).toContain("hunter2");
    });
  });

  it("surfaces the server's CDN staleness warning as a toast (password path)", async () => {
    const published = { ...CANVAS, publicationState: "published", currentVersionId: "v1" };
    mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "PATCH /api/canvases/c1/settings": () =>
        json({
          ...published,
          hasPassword: true,
          warning: "CDN edge may keep showing this canvas.",
        }),
    });
    const user = userEvent.setup();
    renderShare();

    await user.type(await screen.findByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: /set password/i }));

    expect(await screen.findByText(/CDN edge may keep showing this canvas/i)).toBeInTheDocument();
  });

  it("surfaces the CDN warning when an access change (save) returns one", async () => {
    const published = { ...CANVAS, publicationState: "published", currentVersionId: "v1" };
    mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "PATCH /api/canvases/c1/settings": () =>
        json({
          ...published,
          access: "whole_org",
          warning: "Heads up: a CDN may keep serving it.",
        }),
    });
    const user = userEvent.setup();
    renderShare();

    await user.click(await screen.findByRole("radio", { name: /whole org/i }));
    expect(await screen.findByText(/a CDN may keep serving it/i)).toBeInTheDocument();
  });

  it("shows an error toast when an access change (save) fails (no silent swallow)", async () => {
    const published = { ...CANVAS, publicationState: "published", currentVersionId: "v1" };
    mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "PATCH /api/canvases/c1/settings": () =>
        json(
          { code: "SHARE_REQUIRES_PUBLISH", message: "Could not change the access level." },
          409,
        ),
    });
    const user = userEvent.setup();
    renderShare();

    await user.click(await screen.findByRole("radio", { name: /whole org/i }));
    expect(await screen.findByText(/could not change the access level/i)).toBeInTheDocument();
  });

  it("Generate fills a strong password and reveals it for copying", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" }),
    });
    const user = userEvent.setup();
    renderShare();

    const input = (await screen.findByLabelText("Password")) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.type).toBe("password");

    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect(input.value.length).toBeGreaterThanOrEqual(16);
    expect(input.type).toBe("text");
  });

  it("unpublished: shows ONE locked-panel explanation, not live access controls", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json(CANVAS) });
    renderShare();

    // A single coherent explanation of the dependency — not a notice repeated under
    // every section.
    expect(await screen.findByText(/sharing unlocks after you publish/i)).toBeInTheDocument();
    expect(screen.getAllByText(/sharing unlocks after you publish/i)).toHaveLength(1);

    // The access ladder / gallery controls are NOT shown as live affordances.
    expect(screen.queryByRole("radio", { name: /whole org/i })).toBeNull();
    expect(screen.queryByRole("switch", { name: /list in the gallery/i })).toBeNull();

    // The CTA offers both ways forward (scoped to the locked panel, not the header).
    const panel = screen.getByRole("region", { name: /sharing unlocks after you publish/i });
    expect(within(panel).getByRole("button", { name: /^publish$/i })).toBeEnabled();
    expect(within(panel).getByRole("link", { name: /open draft/i })).toBeInTheDocument();
  });

  it("unpublished: Publish CTA fires the publish mutation and reveals the ladder in place", async () => {
    let published = false;
    mockFetch({
      "GET /api/canvases/c1": () =>
        published
          ? json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" })
          : json(CANVAS),
      "POST /api/canvases/c1/publish": () => {
        published = true;
        return json({ version: 1 });
      },
    });
    const user = userEvent.setup();
    renderShare();

    const panel = await screen.findByRole("region", {
      name: /sharing unlocks after you publish/i,
    });
    await user.click(within(panel).getByRole("button", { name: /^publish$/i }));

    // After publishing, the canvas-detail query is invalidated/refetched; the tab
    // re-renders with the access ladder revealed in place (no navigation).
    expect(await screen.findByRole("radio", { name: /whole org/i })).toBeEnabled();
    expect(screen.queryByText(/sharing unlocks after you publish/i)).toBeNull();
  });

  it("General access offers Restricted / Whole org / Public link; a legacy team rung reads as Restricted", async () => {
    const published = {
      ...CANVAS,
      publicationState: "published",
      access: "team",
      shared: true,
      teamIds: ["t1"],
      currentVersionId: "v1",
    };
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "GET /api/teams": () =>
        json({
          teams: [
            { id: "t1", orgId: "o1", name: "Design", slug: "design", mine: true, canManage: true },
          ],
        }),
      "GET /api/canvases/c1/allowlist": () =>
        json({
          entries: [
            {
              id: "owner",
              kind: "owner",
              role: "owner",
              email: "owner@example.com",
              name: "Owner",
              userId: "u1",
            },
            {
              id: "team:t1",
              kind: "team",
              role: "viewer",
              teamId: "t1",
              name: "Design",
              teamOrgId: "o1",
            },
          ],
        }),
      "PATCH /api/canvases/c1/settings": () =>
        json({ ...published, access: "whole_org", teamIds: ["t1"] }),
    });
    const user = userEvent.setup();
    renderShare();

    // The legacy `team` value displays as Restricted; the old rungs are gone from the picker.
    expect(await screen.findByRole("radio", { name: /restricted/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /whole org/i })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /^team/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: /specific people/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: /private/i })).toBeNull();
    // The team stays on the people list, unaffected by whatever the picker does.
    expect(await screen.findByText("Acme")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /whole org/i }));
    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch?.body).toContain('"access":"whole_org"');
      // No `teamIds` rides along: team grants live on the list (restricted access model).
      expect(patch?.body).not.toContain("teamIds");
    });
  });

  it("picking Restricted on a Whole-org canvas PATCHes access:private (Restricted writes the base rung)", async () => {
    const published = {
      ...CANVAS,
      publicationState: "published",
      access: "whole_org",
      shared: true,
      currentVersionId: "v1",
    };
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "PATCH /api/canvases/c1/settings": () =>
        json({ ...published, access: "private", shared: false }),
    });
    const user = userEvent.setup();
    renderShare();

    await user.click(await screen.findByRole("radio", { name: /restricted/i }));
    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch?.body).toContain('"access":"private"');
    });
  });

  it("a guest (no org) sees Restricted but no Whole-org choice", async () => {
    mockFetch({
      "GET /api/me": () => json({ ...ME, isGuest: true, orgs: [] }),
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" }),
    });
    renderShare();
    expect(await screen.findByRole("radio", { name: /restricted/i })).toBeChecked();
    expect(screen.queryByRole("radio", { name: /whole org/i })).toBeNull();
  });

  it("whole-org rung is disabled on a Personal canvas; Restricted stays enabled", async () => {
    mockFetch({
      "GET /api/me": () => json({ ...ME, orgs: [{ id: "o1", name: "Acme" }] }),
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, orgId: null, publicationState: "published", currentVersionId: "v1" }),
    });
    renderShare();
    expect(await screen.findByRole("radio", { name: /restricted/i })).toBeEnabled();
    // …but it still can't be shared org-wide.
    expect(screen.getByRole("radio", { name: /whole org/i })).toBeDisabled();
  });

  it("published: shows the live access ladder (rungs are enabled)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" }),
    });
    renderShare();

    expect(await screen.findByRole("radio", { name: /restricted/i })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /whole org/i })).toBeEnabled();
  });

  it("uses the direct-access hierarchy, keeps the header URL controls, and preserves the Protection anchor", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" }),
    });
    renderShare();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Sharing and permissions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Control who can open this canvas and what they can do."),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Share link" })).toBeNull();
    expect(screen.getByRole("link", { name: CANVAS.url })).toHaveAttribute("href", CANVAS.url);
    expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled();
    expect(document.getElementById("locks")).toHaveTextContent("Protection");

    const sectionNames = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(sectionNames).toEqual([
      "People and teams with direct access",
      "General access",
      "Protection",
      "Gallery & templates",
      "Advanced",
    ]);
  });

  it("People and Teams tabs switch one add form while the unified list stays visible", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" }),
      "GET /api/teams": () =>
        json({
          teams: [
            { id: "t1", orgId: "o1", name: "Design", slug: "design", mine: true, canManage: true },
          ],
        }),
      "GET /api/canvases/c1/allowlist": () =>
        json({
          entries: [
            {
              id: "owner",
              kind: "owner",
              role: "owner",
              email: "owner@example.com",
              name: "Owner",
              userId: "u1",
            },
          ],
        }),
      "POST /api/canvases/c1/allowlist": () =>
        json({ ok: true, status: "granted", role: "editor" }),
    });
    const user = userEvent.setup();
    renderShare();

    const list = await screen.findByRole("list", { name: "People and teams" });
    expect(within(list).getByText("owner@example.com")).toBeVisible();
    const peopleTab = screen.getByRole("tab", { name: "People" });
    const teamsTab = screen.getByRole("tab", { name: "Teams" });
    expect(peopleTab).toHaveAttribute("aria-selected", "true");
    const emailInput = screen.getByLabelText("Person's email");
    const personRole = screen.getByRole("combobox", { name: "Role for the person to add" });
    const addButton = screen.getByRole("button", { name: "Add" });
    expect(emailInput).toBeVisible();
    expect(emailInput).toHaveClass("h-10");
    expect(personRole).toHaveClass("h-10");
    expect(addButton).toHaveClass("h-10", "bg-accent");
    expect(addButton).toBeDisabled();
    await user.type(emailInput, "madeleine.gedda@seenthis.se");
    expect(addButton).toBeEnabled();

    teamsTab.focus();
    await user.keyboard("{Enter}");
    expect(teamsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByLabelText("Person's email")).toBeNull();
    expect(within(list).getByText("owner@example.com")).toBeVisible();
    await user.selectOptions(screen.getByRole("combobox", { name: "Team to add" }), "t1");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Role for the team to add" }),
      "editor",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await vi.waitFor(() => {
      const post = calls.find(
        (call) => call.method === "POST" && call.url === "/api/canvases/c1/allowlist",
      );
      expect(post?.body).toContain('"teamId":"t1"');
      expect(post?.body).toContain('"role":"editor"');
    });

    teamsTab.focus();
    await user.keyboard("{ArrowLeft}");
    expect(peopleTab).toHaveAttribute("aria-selected", "true");
    expect(peopleTab).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expect(teamsTab).toHaveAttribute("aria-selected", "true");
    expect(teamsTab).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(peopleTab).toHaveAttribute("aria-selected", "true");
    expect(peopleTab).toHaveFocus();
    await user.keyboard("{End}");
    expect(teamsTab).toHaveFocus();
    await user.keyboard("{Home}");
    expect(peopleTab).toHaveFocus();
  });

  it("shows the human-guessable heads-up for a custom slug on a link-reachable rung", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          slugCustom: true,
          publicationState: "published",
          access: "whole_org",
          shared: true,
          currentVersionId: "v1",
        }),
    });
    renderShare();
    expect(await screen.findByText(/custom, human-readable URL/i)).toBeInTheDocument();
  });

  it("hides the heads-up for a random slug on a link-reachable rung", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          slugCustom: false,
          publicationState: "published",
          access: "whole_org",
          shared: true,
          currentVersionId: "v1",
        }),
    });
    renderShare();
    await screen.findByRole("radio", { name: /whole org/i });
    expect(screen.queryByText(/custom, human-readable URL/i)).not.toBeInTheDocument();
  });

  it("hides the heads-up for a custom slug kept private (obscurity still applies)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          slugCustom: true,
          publicationState: "published",
          access: "private",
          shared: false,
          currentVersionId: "v1",
        }),
    });
    renderShare();
    await screen.findByRole("radio", { name: /restricted/i });
    expect(screen.queryByText(/custom, human-readable URL/i)).not.toBeInTheDocument();
  });

  it("specific_people: shows the allowlist empty state and adds a member", async () => {
    const user = userEvent.setup();
    let added = false;
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "specific_people",
          shared: true,
          currentVersionId: "v1",
        }),
      "GET /api/canvases/c1/allowlist": () =>
        json({
          entries: added
            ? [
                {
                  id: "e1",
                  kind: "member",
                  email: "colleague@example.com",
                  name: "C",
                  createdAt: 1,
                },
              ]
            : [],
        }),
      "POST /api/canvases/c1/allowlist": () => {
        added = true;
        return json({ ok: true, status: "granted" });
      },
    });
    renderShare();

    expect(await screen.findByText(/no one else has direct access yet/i)).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/person's email/i), "colleague@example.com");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("colleague@example.com")).toBeInTheDocument();
  });

  it("specific_people: Add person records a pending external email", async () => {
    const user = userEvent.setup();
    let pending = false;
    const calls = mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "specific_people",
          shared: true,
          currentVersionId: "v1",
        }),
      "GET /api/canvases/c1/allowlist": () =>
        json({
          entries: pending
            ? [
                {
                  id: "pending:p1",
                  kind: "pending",
                  email: "newbie@example.com",
                  name: null,
                  createdAt: 1,
                },
              ]
            : [],
        }),
      "POST /api/canvases/c1/allowlist": () => {
        pending = true;
        return json({ ok: true, status: "pending", emailDelivery: { status: "sent" } });
      },
    });
    renderShare();

    await user.type(await screen.findByLabelText(/person's email/i), "newbie@example.com");
    expect(screen.queryByRole("button", { name: "Invite" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Access pending until sign-in. Email sent")).toBeInTheDocument();
    expect(await screen.findByText("newbie@example.com")).toBeInTheDocument();
    expect(screen.getByText(/pending sign-in/i)).toBeInTheDocument();
    await vi.waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/canvases/c1/allowlist");
      expect(post?.body).toContain("newbie@example.com");
    });
  });

  it("updates added-people AI settings when a legacy guest is on the list", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "specific_people",
          shared: true,
          currentVersionId: "v1",
        }),
      "GET /api/canvases/c1/allowlist": () =>
        json({
          entries: [
            {
              id: "guest:g9",
              kind: "guest",
              role: "viewer",
              email: "g@partner.com",
              name: null,
              userId: null,
              createdAt: 1,
            },
          ],
        }),
      "PATCH /api/canvases/c1/settings": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "specific_people",
          shared: true,
          currentVersionId: "v1",
          guestAiEnabled: true,
        }),
    });
    const user = userEvent.setup();
    renderShare();

    await user.click(await screen.findByRole("switch", { name: /allow added people to use ai/i }));

    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch?.body).toContain("guestAiEnabled");
      expect(patch?.body).toContain("true");
    });
  });

  it("Restricted hint says 'only you' while the list holds just the owner, and counts the list otherwise", async () => {
    const published = { ...CANVAS, publicationState: "published", currentVersionId: "v1" };
    mockFetch({
      // The Public link choice (and its hint) only renders for an account that may publish publicly.
      "GET /api/me": () => json({ ...ME, canPublishPublic: true }),
      "GET /api/canvases/c1": () => json(published),
      "GET /api/canvases/c1/allowlist": () =>
        json({
          entries: [
            {
              id: "owner",
              kind: "owner",
              role: "owner",
              email: "owner@example.com",
              name: "Owner",
              userId: "u1",
              createdAt: 1,
            },
          ],
        }),
    });
    renderShare();
    expect(await screen.findByText(/only you currently have access/i)).toBeInTheDocument();
    // Changing General access is explained as additive to the list.
    expect(screen.getByText(/never removes the people and teams above/i)).toBeInTheDocument();
    // Public link explains that listed people keep full access.
    expect(screen.getByText(/people and teams above keep their full access/i)).toBeInTheDocument();
  });

  it("Restricted hint names how many people and teams the list holds — never 'only you' with grants", async () => {
    const published = { ...CANVAS, publicationState: "published", currentVersionId: "v1" };
    mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "GET /api/canvases/c1/allowlist": () =>
        json({
          entries: [
            {
              id: "owner",
              kind: "owner",
              role: "owner",
              email: "owner@example.com",
              name: "Owner",
              userId: "u1",
              createdAt: 1,
            },
            {
              id: "member:m1",
              kind: "member",
              role: "viewer",
              email: "liam@example.com",
              name: "Liam",
              userId: "u2",
              createdAt: 2,
            },
            {
              id: "team:t1",
              kind: "team",
              role: "viewer",
              email: null,
              name: "Design",
              userId: null,
              teamId: "t1",
              teamOrgId: "o1",
              createdAt: 3,
            },
          ],
        }),
    });
    renderShare();
    expect(
      await screen.findByText(/only you and the 2 people and teams above can open it/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/only you currently have access/i)).toBeNull();
  });

  it("the guest-AI section follows a legacy guest on the list, not General access", async () => {
    const guest = {
      id: "guest:g1",
      kind: "guest",
      role: "viewer",
      email: "g@partner.com",
      name: null,
      userId: null,
      createdAt: 1,
    };
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "whole_org",
          shared: true,
          currentVersionId: "v1",
        }),
      "GET /api/canvases/c1/allowlist": () => json({ entries: [guest] }),
    });
    renderShare();
    // Whole org + a legacy guest: the AI opt-in is offered.
    expect(
      await screen.findByRole("switch", { name: /allow added people to use ai/i }),
    ).toBeInTheDocument();
  });

  it("the guest-AI section stays hidden on a Restricted canvas with no legacy guest", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" }),
      "GET /api/canvases/c1/allowlist": () => json({ entries: [] }),
    });
    renderShare();
    await screen.findByRole("radio", { name: /restricted/i });
    expect(screen.queryByRole("switch", { name: /allow added people to use ai/i })).toBeNull();
  });

  it("a pending invite is not counted as someone who can open the canvas (review #4)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" }),
      "GET /api/canvases/c1/allowlist": () =>
        json({
          entries: [
            {
              id: "owner",
              kind: "owner",
              role: "owner",
              email: "owner@example.com",
              name: "Owner",
              userId: "u1",
              createdAt: 1,
            },
            {
              id: "pending:p1",
              kind: "pending",
              role: "viewer",
              email: "new@example.com",
              name: null,
              userId: null,
              createdAt: 2,
            },
          ],
        }),
    });
    renderShare();
    expect(await screen.findByText(/only you currently have access/i)).toBeInTheDocument();
  });

  it("a failed people-list load never reads as an empty list (review #3)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          currentVersionId: "v1",
          hasPassword: true,
        }),
      "GET /api/canvases/c1/allowlist": () => json({ error: "boom" }, 500),
    });
    renderShare();
    await screen.findByRole("radio", { name: /restricted/i });
    // The neutral sentence, not "only you"; the password notice stays general too.
    expect(
      screen.getByText(/^only the people and teams above can open it\.$/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/only you currently have access/i)).toBeNull();
    expect(screen.queryByText(/gates no one/i)).toBeNull();
    expect(screen.getByText(/asked for this password too/i)).toBeInTheDocument();
    expect(screen.getByText(/try again before relying on who appears here/i)).toBeInTheDocument();
    expect(screen.queryByText(/no one added yet/i)).toBeNull();
  });

  it("clears the prior canvas's people list while navigation loads the next one", async () => {
    let resolveSecondList: ((response: Response) => void) | undefined;
    const secondList = new Promise<Response>((resolve) => {
      resolveSecondList = resolve;
    });
    const calls = mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" }),
      "GET /api/canvases/c1/allowlist": () =>
        json({
          entries: [
            {
              id: "member:old",
              kind: "member",
              role: "viewer",
              email: "old@example.com",
              userId: "old",
            },
          ],
        }),
      "GET /api/canvases/c2": () =>
        json({
          ...CANVAS,
          id: "c2",
          slug: "second-canvas",
          url: "http://x/c/second-canvas",
          publicationState: "published",
          currentVersionId: "v2",
        }),
      "GET /api/canvases/c2/allowlist": () => secondList,
    });
    const router = renderShare();
    expect(await screen.findByText("old@example.com")).toBeInTheDocument();

    await router.navigate({ to: "/canvases/$id/share", params: { id: "c2" } });
    await vi.waitFor(() =>
      expect(
        calls.some((call) => call.method === "GET" && call.url === "/api/canvases/c2/allowlist"),
      ).toBe(true),
    );
    expect(screen.queryByText("old@example.com")).toBeNull();

    resolveSecondList?.(
      json({
        entries: [
          {
            id: "member:new",
            kind: "member",
            role: "viewer",
            email: "new@example.com",
            userId: "new",
          },
        ],
      }),
    );
    expect(await screen.findByText("new@example.com")).toBeInTheDocument();
  });

  it.each(["success", "failure"] as const)(
    "ignores a late %s from the previous canvas after the next list has loaded",
    async (lateResult) => {
      let resolveFirstList: ((response: Response) => void) | undefined;
      const firstList = new Promise<Response>((resolve) => {
        resolveFirstList = resolve;
      });
      mockFetch({
        "GET /api/canvases/c1": () =>
          json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" }),
        "GET /api/canvases/c1/allowlist": () => firstList,
        "GET /api/canvases/c2": () =>
          json({
            ...CANVAS,
            id: "c2",
            slug: "second-canvas",
            url: "http://x/c/second-canvas",
            publicationState: "published",
            currentVersionId: "v2",
          }),
        "GET /api/canvases/c2/allowlist": () =>
          json({
            entries: [
              {
                id: "member:new",
                kind: "member",
                role: "viewer",
                email: "new@example.com",
                userId: "new",
              },
            ],
          }),
      });
      const router = renderShare();
      await screen.findByRole("radio", { name: /restricted/i });

      await router.navigate({ to: "/canvases/$id/share", params: { id: "c2" } });
      expect(await screen.findByText("new@example.com")).toBeInTheDocument();

      resolveFirstList?.(
        lateResult === "success"
          ? json({
              entries: [
                {
                  id: "member:old",
                  kind: "member",
                  role: "viewer",
                  email: "old@example.com",
                  userId: "old",
                },
              ],
            })
          : json({ error: "late failure" }, 500),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(screen.getByText("new@example.com")).toBeInTheDocument();
      expect(screen.queryByText("old@example.com")).toBeNull();
      expect(screen.queryByText(/try again before relying on who appears here/i)).toBeNull();
    },
  );

  it("the password notice names editors AND legacy guests as exempt, and says 'gates no one' only for a loaded empty list (review #2)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          currentVersionId: "v1",
          hasPassword: true,
        }),
      "GET /api/canvases/c1/allowlist": () =>
        json({
          entries: [
            {
              id: "guest:g1",
              kind: "guest",
              role: "viewer",
              email: "g@partner.com",
              name: null,
              userId: null,
              createdAt: 1,
            },
          ],
        }),
    });
    renderShare();
    expect(
      await screen.findByText(/asked for this password too; editors and legacy guests never are/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/gates no one/i)).toBeNull();
  });

  it("with a loaded empty list the password notice says it gates no one and the expiry field stays hidden (review #13)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          currentVersionId: "v1",
          hasPassword: true,
        }),
      "GET /api/canvases/c1/allowlist": () => json({ entries: [] }),
    });
    renderShare();
    expect(await screen.findByText(/gates no one/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/share expiry/i)).toBeNull();
  });

  it("one listed person shows the singular hint and the expiry field (review #13)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" }),
      "GET /api/canvases/c1/allowlist": () =>
        json({
          entries: [
            {
              id: "member:m1",
              kind: "member",
              role: "viewer",
              email: "liam@example.com",
              name: "Liam",
              userId: "u2",
              createdAt: 2,
            },
          ],
        }),
    });
    renderShare();
    expect(
      await screen.findByText(/only you and the one person or team above can open it/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/share expiry/i)).toBeInTheDocument();
  });

  it("a Restricted canvas with an expiry shows the expiry field even with an empty list (review #13)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          currentVersionId: "v1",
          sharedExpiresAt: Date.now() + 86_400_000,
        }),
      "GET /api/canvases/c1/allowlist": () => json({ entries: [] }),
    });
    renderShare();
    await screen.findByRole("radio", { name: /restricted/i });
    expect(await screen.findByLabelText(/share expiry/i)).toBeInTheDocument();
  });

  it("warns when a shared canvas's expiry is already in the past", async () => {
    const past = Date.now() - 60 * 60 * 1000;
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", shared: true, sharedExpiresAt: past }),
    });
    renderShare();

    expect(await screen.findByText(/this share expired/i)).toBeInTheDocument();
    expect(screen.getByText(/non-owners now get a 404/i)).toBeInTheDocument();
  });

  it("shows no expiry warning when the expiry is still in the future", async () => {
    const future = Date.now() + 24 * 60 * 60 * 1000;
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", shared: true, sharedExpiresAt: future }),
    });
    renderShare();

    expect(await screen.findByText(/share expiry/i)).toBeInTheDocument();
    expect(screen.queryByText(/this share expired/i)).toBeNull();
  });

  it("clears an existing share expiry with one explicit action", async () => {
    const future = Date.now() + 24 * 60 * 60 * 1000;
    const published = {
      ...CANVAS,
      publicationState: "published",
      access: "public_link" as const,
      shared: true,
      currentVersionId: "v1",
      sharedExpiresAt: future,
    };
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "PATCH /api/canvases/c1/settings": () => json({ ...published, sharedExpiresAt: null }),
    });
    const user = userEvent.setup();
    renderShare();

    await user.click(await screen.findByRole("button", { name: /remove expiry/i }));
    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch?.body).toContain('"sharedExpiresAt":null');
    });
  });

  it("gallery-listing control is discoverable but disabled until the canvas is gallery-eligible", async () => {
    // Published but still private: sharing is unlocked, so the gallery control is
    // visible, but listBlocker (only Whole-org / Public-link canvases can be listed)
    // keeps it disabled — specific_people/private never appear in the gallery.
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", currentVersionId: "v1", shared: false }),
    });
    renderShare();

    const toggle = await screen.findByRole("switch", { name: /list in the gallery/i });
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/only a whole-org or public-link canvas/i)).toBeInTheDocument();
  });

  it("gallery-listing control is enabled once the canvas is Whole-org AND published", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "whole_org",
          discoverability: "listed",
          shared: true,
          currentVersionId: "v1",
        }),
    });
    renderShare();

    const toggle = await screen.findByRole("switch", { name: /list in the gallery/i });
    expect(toggle).toBeEnabled();
  });

  it("lists a URL-only Whole-org canvas in one action and explains the org audience", async () => {
    const published = {
      ...CANVAS,
      publicationState: "published",
      access: "whole_org" as const,
      discoverability: "link_only" as const,
      shared: true,
      currentVersionId: "v1",
    };
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "PATCH /api/canvases/c1/settings": () =>
        json({ ...published, discoverability: "listed", galleryListed: true }),
    });
    const user = userEvent.setup();
    renderShare();

    const toggle = await screen.findByRole("switch", { name: /list in the gallery/i });
    expect(toggle).toBeEnabled();
    expect(
      screen.getByText(/anyone in your organization can discover and open/i),
    ).toBeInTheDocument();
    await user.click(toggle);
    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch?.body).toContain('"galleryListed":true');
    });
  });

  it("saves the Shared discoverability toggle for Whole-org canvases", async () => {
    const published = {
      ...CANVAS,
      publicationState: "published",
      access: "whole_org",
      shared: true,
      currentVersionId: "v1",
    };
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "PATCH /api/canvases/c1/settings": () => json({ ...published, discoverability: "listed" }),
    });
    const user = userEvent.setup();
    renderShare();

    await user.click(await screen.findByRole("switch", { name: /list for your org/i }));
    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch?.body).toContain('"discoverability":"listed"');
    });
  });

  it("does not show the Shared discoverability toggle for Public-link canvases", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "public_link",
          shared: true,
          currentVersionId: "v1",
        }),
    });
    renderShare();

    await screen.findByRole("switch", { name: /list in the gallery/i });
    expect(screen.getByText(/anyone signed in can discover this canvas/i)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /list for people with access/i })).toBeNull();
  });

  it("an unpublished canvas shows the locked panel, not the gallery-listing control", async () => {
    // The publish dependency is collapsed into the single locked panel (U13), so the
    // gallery section — and its listBlocker "publish first" notice — is not reachable
    // while the canvas is a draft. listBlocker still gates the published path below.
    mockFetch({
      "GET /api/canvases/c1": () => json({ ...CANVAS, shared: true, currentVersionId: null }),
    });
    renderShare();

    expect(await screen.findByText(/sharing unlocks after you publish/i)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /list in the gallery/i })).toBeNull();
  });

  it("gallery-listing is blocked for a password-protected canvas", async () => {
    // Whole-org + published, so the access/publish blockers clear and the password
    // blocker is the one that surfaces.
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "whole_org",
          discoverability: "listed",
          shared: true,
          currentVersionId: "v1",
          hasPassword: true,
        }),
    });
    renderShare();

    const toggle = await screen.findByRole("switch", { name: /list in the gallery/i });
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/remove the password before listing/i)).toBeInTheDocument();
  });

  it("shows the template toggle once listed, and warns before a password unlists", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "whole_org",
          discoverability: "listed",
          shared: true,
          currentVersionId: "v1",
          galleryListed: true,
        }),
      "PATCH /api/canvases/c1/settings": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          shared: true,
          currentVersionId: "v1",
          hasPassword: true,
        }),
    });
    const user = userEvent.setup();
    renderShare();

    expect(
      await screen.findByRole("switch", { name: /allow others to use as a template/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/visible to your organization in the gallery/i)).toBeInTheDocument();
    expect(screen.getByText(/visible to your organization once/i)).toBeInTheDocument();
    expect(screen.queryByText(/shown publicly in the gallery/i)).toBeNull();
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: /set password/i }));
    expect(await screen.findByText(/add a password and unlist/i)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);

    await user.click(screen.getByRole("button", { name: /add password & remove from gallery/i }));
    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch?.body).toContain("hunter2");
    });
  });

  it("gallery section has no editable tags input — it points to Overview instead", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "whole_org",
          discoverability: "listed",
          shared: true,
          currentVersionId: "v1",
          galleryListed: true,
        }),
    });
    renderShare();

    // The redundant gallery-tags input is gone (tags are a first-class Overview property).
    await screen.findByRole("switch", { name: /allow others to use as a template/i });
    expect(screen.queryByLabelText("Tags")).toBeNull();
    // A read-only note points the owner to the unified editor.
    const note = screen.getByText(/tags are set in/i);
    expect(note).toBeInTheDocument();
    expect(within(note).getByRole("link", { name: /overview/i })).toHaveAttribute(
      "href",
      "/canvases/c1",
    );
  });

  it("surfaces a gallery-toggle server rejection as an error toast", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "whole_org",
          discoverability: "listed",
          shared: true,
          currentVersionId: "v1",
          galleryListed: true,
        }),
      "PATCH /api/canvases/c1/settings": () =>
        json({ code: "NOT_PUBLISHED", message: "Publish this canvas before listing it." }, 409),
    });
    const user = userEvent.setup();
    renderShare();

    await user.click(
      await screen.findByRole("switch", { name: /allow others to use as a template/i }),
    );
    expect(
      await screen.findByText(/publish this canvas before listing it in the gallery/i),
    ).toBeInTheDocument();
  });
});

describe("share route — roles and ownership (editor-roles plan U6)", () => {
  const published = {
    ...CANVAS,
    publicationState: "published",
    currentVersionId: "v1",
    role: "owner",
    ownerId: "u1",
    owner: { id: "u1", name: "Owner", email: "owner@example.com" },
  };
  const entries = [
    {
      id: "owner",
      kind: "owner",
      role: "owner",
      email: "owner@example.com",
      name: "Owner",
      userId: "u1",
      teamId: null,
      createdAt: 0,
    },
    {
      id: "member:e1",
      kind: "member",
      role: "viewer",
      email: "colleague@example.com",
      name: "Cole",
      userId: "u2",
      teamId: null,
      createdAt: 1,
    },
    {
      id: "member:e2",
      kind: "member",
      role: "editor",
      email: "edna@example.com",
      name: "Edna",
      userId: "u3",
      teamId: null,
      createdAt: 2,
    },
    {
      id: "guest:g1",
      kind: "guest",
      role: "viewer",
      email: "g@partner.com",
      name: null,
      userId: null,
      teamId: null,
      createdAt: 3,
    },
  ];

  it("the owner row is pinned first with no controls; a member's role select PATCHes the entry; a guest has no role control", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "GET /api/canvases/c1/allowlist": () => json({ entries }),
      "PATCH /api/canvases/c1/allowlist/member:e1": () => json({ ok: true }),
    });
    renderShare();
    const list = await screen.findByRole("list", { name: /people and teams/i });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("owner@example.com");
    expect(within(rows[0] as HTMLElement).getByText("Owner")).toBeInTheDocument();
    expect(
      within(rows[0] as HTMLElement).queryByRole("button", { name: /actions for/i }),
    ).toBeNull();
    expect(screen.queryByRole("combobox", { name: /role for owner@example.com/i })).toBeNull();
    // Guests only view.
    expect(screen.queryByRole("combobox", { name: /role for g@partner.com/i })).toBeNull();
    // Promote Cole.
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Role for colleague@example.com" }),
      "editor",
    );
    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/allowlist/member:e1",
      );
      expect(patch?.body).toContain('"role":"editor"');
    });
  });

  it("invalidates the parent access mirror when a post-mutation list refresh fails", async () => {
    let listReads = 0;
    const user = userEvent.setup();
    mockFetch({
      "GET /api/canvases/c1": () => json({ ...published, hasPassword: true }),
      "GET /api/canvases/c1/allowlist": () => {
        listReads += 1;
        return listReads === 1 ? json({ entries }) : json({ error: "refresh failed" }, 500);
      },
      "PATCH /api/canvases/c1/allowlist/member:e1": () => json({ ok: true }),
    });
    renderShare();
    expect(await screen.findByText("AI for added people")).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Role for colleague@example.com" }),
      "editor",
    );

    expect(
      await screen.findByText(/try again before relying on who appears here/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("AI for added people")).toBeNull();
    expect(screen.queryByText(/gates no one/i)).toBeNull();
  });

  it("adding a person as an editor sends the role", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "GET /api/canvases/c1/allowlist": () => json({ entries }),
      "POST /api/canvases/c1/allowlist": () => json({ ok: true, status: "granted" }),
    });
    renderShare();
    await user.type(await screen.findByLabelText(/person's email/i), "new@example.com");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Role for the person to add" }),
      "editor",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await vi.waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/canvases/c1/allowlist");
      expect(post?.body).toContain('"role":"editor"');
    });
  });

  it("owner's view: Transfer ownership lists the editors, POSTs the chosen user id, and re-reads the people list (F4)", async () => {
    const user = userEvent.setup();
    // After the transfer the server lists Edna as the owner and the previous owner as an
    // editor — the list must re-read rather than keep showing the pre-transfer roles.
    let transferred = false;
    const afterTransfer = [
      {
        id: "owner",
        kind: "owner",
        role: "owner",
        email: "edna@example.com",
        name: "Edna",
        userId: "u3",
        teamId: null,
        createdAt: 0,
      },
      {
        id: "member:e9",
        kind: "member",
        role: "editor",
        email: "owner@example.com",
        name: "Owner",
        userId: "u1",
        teamId: null,
        createdAt: 4,
      },
    ];
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "GET /api/canvases/c1/allowlist": () =>
        json({ entries: transferred ? afterTransfer : entries }),
      "POST /api/canvases/c1/transfer": () => {
        transferred = true;
        return json({
          ok: true,
          canvas: { ...published, role: "editor", ownerId: "u3" },
          previousOwnerEditor: true,
          publicLinkReverted: false,
        });
      },
    });
    renderShare();
    const transferButton = await screen.findByRole("button", { name: /transfer ownership/i });
    await vi.waitFor(() => expect(transferButton).toBeEnabled());
    await user.click(transferButton);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/you keep editor access/i)).toBeInTheDocument();
    // Only editors are offered (Edna), never viewers or guests.
    expect(within(dialog).getByLabelText(/Edna/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/Cole/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: /transfer ownership/i }));
    await vi.waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/canvases/c1/transfer");
      expect(post?.body).toContain('"toUserId":"u3"');
    });
    expect(await screen.findByText(/you're now an editor/i)).toBeInTheDocument();
    // The people list was re-read: Edna's row now carries the Owner badge and the previous
    // owner's row a role control set to editor.
    await vi.waitFor(() => {
      const list = screen.getByRole("list", { name: /people and teams/i });
      const edna = within(list).getByText("edna@example.com").closest("li") as HTMLElement;
      expect(within(edna).getByText("Owner")).toBeInTheDocument();
      expect(
        within(list).getByRole("combobox", { name: "Role for owner@example.com" }),
      ).toHaveValue("editor");
    });
    expect(
      calls.filter((c) => c.method === "GET" && c.url === "/api/canvases/c1/allowlist").length,
    ).toBeGreaterThan(1);
  });

  it("ignores a transfer completion after navigation to another canvas", async () => {
    const user = userEvent.setup();
    let resolveTransfer: ((response: Response) => void) | undefined;
    const pendingTransfer = new Promise<Response>((resolve) => {
      resolveTransfer = resolve;
    });
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "GET /api/canvases/c1/allowlist": () => json({ entries }),
      "POST /api/canvases/c1/transfer": () => pendingTransfer,
      "GET /api/canvases/c2": () =>
        json({
          ...published,
          id: "c2",
          slug: "second-canvas",
          url: "http://x/c/second-canvas",
        }),
      "GET /api/canvases/c2/allowlist": () => json({ entries }),
    });
    const router = renderShare();
    const transferButton = await screen.findByRole("button", { name: /transfer ownership/i });
    await vi.waitFor(() => expect(transferButton).toBeEnabled());
    await user.click(transferButton);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: /transfer ownership/i,
      }),
    );
    await vi.waitFor(() =>
      expect(
        calls.some((call) => call.method === "POST" && call.url === "/api/canvases/c1/transfer"),
      ).toBe(true),
    );

    await router.navigate({ to: "/canvases/$id/share", params: { id: "c2" } });
    expect(await screen.findByRole("link", { name: "http://x/c/second-canvas" })).toBeVisible();
    resolveTransfer?.(
      json({
        ok: true,
        canvas: { ...published, role: "editor", ownerId: "u3" },
        previousOwnerEditor: true,
        publicLinkReverted: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText(/ownership transferred/i)).toBeNull();
    expect(
      calls.filter((call) => call.method === "GET" && call.url === "/api/canvases/c2/allowlist"),
    ).toHaveLength(1);
  });

  it("editor's view: no Transfer ownership control; the added-people AI opt-in is owner-only", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...published,
          access: "specific_people",
          shared: true,
          role: "editor",
          ownerId: "u9",
          owner: { id: "u9", name: "Olive", email: "o@example.com" },
        }),
      "GET /api/canvases/c1/allowlist": () => json({ entries }),
    });
    renderShare();
    await screen.findByRole("list", { name: /people and teams/i });
    expect(screen.queryByRole("button", { name: /transfer ownership/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Advanced" })).toBeNull();
    expect(await screen.findByText(/only the owner can change the ai opt-in/i)).toBeInTheDocument();
  });

  it("review #8: a failed transfer toasts, keeps the dialog open, and does not re-read the list", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "GET /api/canvases/c1/allowlist": () => json({ entries }),
      "POST /api/canvases/c1/transfer": () =>
        json({ code: "NOT_ELIGIBLE", message: "Add them as an editor first." }, 400),
    });
    renderShare();
    const transferButton = await screen.findByRole("button", { name: /transfer ownership/i });
    await vi.waitFor(() => expect(transferButton).toBeEnabled());
    await user.click(transferButton);
    const dialog = await screen.findByRole("dialog");
    const readsBefore = calls.filter(
      (c) => c.method === "GET" && c.url === "/api/canvases/c1/allowlist",
    ).length;
    await user.click(within(dialog).getByRole("button", { name: /transfer ownership/i }));
    expect(await screen.findByText(/add them as an editor first/i)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      calls.filter((c) => c.method === "GET" && c.url === "/api/canvases/c1/allowlist").length,
    ).toBe(readsBefore);
  });

  it("review #7: the transfer picker offers the server's candidates — a team-derived editor with no direct row", async () => {
    const user = userEvent.setup();
    const teamOnly = entries.filter((e) => e.kind !== "member" || e.role !== "editor");
    mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "GET /api/canvases/c1/allowlist": () =>
        json({
          entries: [
            ...teamOnly,
            {
              id: "team:t1",
              kind: "team",
              role: "editor",
              email: null,
              name: "Design",
              userId: null,
              teamId: "t1",
              teamOrgId: null,
              createdAt: 9,
            },
          ],
          transferCandidates: [{ id: "u7", name: "Tia", email: "tia@example.com" }],
        }),
    });
    renderShare();
    const button = await screen.findByRole("button", { name: /transfer ownership/i });
    await vi.waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/Tia/)).toBeInTheDocument();
  });

  it("KTD11 / AE19: removing an editor offers to regenerate the deploy key; declining removes only the grant, confirming mints and reveals a new key", async () => {
    const user = userEvent.setup();
    let removed = false;
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "GET /api/canvases/c1/allowlist": () =>
        json({ entries: removed ? entries.filter((e) => e.id !== "member:e2") : entries }),
      "DELETE /api/canvases/c1/allowlist/member:e2": () => {
        removed = true;
        return json({ ok: true });
      },
      "POST /api/canvases/c1/regenerate-key": () => json({ apiKey: "cdk_new_key_123" }),
      "PATCH /api/canvases/c1/allowlist/member:e2": () => json({ ok: true }),
    });
    renderShare();
    const list = await screen.findByRole("list", { name: /people and teams/i });
    const ednaRow = within(list).getByText("edna@example.com").closest("li") as HTMLElement;
    await user.click(within(ednaRow).getByRole("button", { name: "Actions for edna@example.com" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = await screen.findByRole("dialog", { name: /remove edna@example.com/i });
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    // The grant is gone and the prompt is up.
    const prompt = await screen.findByRole("dialog", { name: /regenerate the deploy key/i });
    expect(prompt).toHaveTextContent(/no longer edits this canvas/i);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    // Decline: nothing else happens.
    await user.click(within(prompt).getByRole("button", { name: /cancel/i }));
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/regenerate-key"))).toBe(false);
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /regenerate the deploy key/i })).toBeNull(),
    );
  });

  it("KTD11 / AE19: demoting an editor to viewer prompts too; confirming regenerates the key and reveals it once", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "GET /api/canvases/c1/allowlist": () => json({ entries }),
      "PATCH /api/canvases/c1/allowlist/member:e2": () => json({ ok: true }),
      "POST /api/canvases/c1/regenerate-key": () => json({ apiKey: "cdk_new_key_123" }),
    });
    renderShare();
    await screen.findByRole("list", { name: /people and teams/i });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Role for edna@example.com" }),
      "viewer",
    );
    const prompt = await screen.findByRole("dialog", { name: /regenerate the deploy key/i });
    await user.click(within(prompt).getByRole("button", { name: /regenerate key/i }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/regenerate-key"))).toBe(
        true,
      ),
    );
    expect(await screen.findByText("cdk_new_key_123")).toBeInTheDocument();
  });
});
